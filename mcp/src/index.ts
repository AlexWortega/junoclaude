#!/usr/bin/env node
// MCP-сервер JunoClaude: инструменты для чтения, генерации и запуска
// содержимого Juno: New Origins.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { gamePaths, assertSafeName } from './paths.js';
import { ToolError, guardedWrite, listSnapshots, restoreSnapshot } from './safety.js';
import { gameStatus, launchGame, quitGame, readLog } from './game.js';
import { parts as partsCatalog, partType, connections } from './catalog.js';
import { Craft } from './craft/model.js';
import { buildCraft, type CraftSpec } from './craft/build.js';
import { summarize, renderSummary, renderTree } from './craft/summary.js';
import { buildXml, parseXmlRoot, GAME_FORMAT } from './xml.js';
import { compileProgram, CompileError, type DslProgram } from './vizzy/compile.js';
import { decompileProgram } from './vizzy/decompile.js';

const server = new McpServer({ name: 'juno', version: '0.1.0' });

/** Ответ тула — всегда текст; ошибки возвращаются значением, а не исключением. */
const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] });

const fail = (e: unknown) => {
  if (e instanceof ToolError)
    return text(
      `Ошибка (${e.code}): ${e.message}` +
        (Object.keys(e.details).length > 0
          ? `\n${JSON.stringify(e.details, null, 2)}`
          : '')
    );
  if (e instanceof CompileError)
    return text(`Ошибка компиляции в ${e.path}: ${e.message}` + (e.hint ? `\n${e.hint}` : ''));
  return text(`Ошибка: ${(e as Error).message}`);
};

/** Оборачивает обработчик, чтобы исключение не роняло соединение. */
const guard =
  <A>(fn: (args: A) => Promise<ReturnType<typeof text>>) =>
  async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      return fail(e);
    }
  };

const craftPath = async (name: string): Promise<string> =>
  join((await gamePaths()).craftDesigns, `${assertSafeName(name, 'Имя крафта')}.xml`);

// --- Состояние игры ---

server.registerTool(
  'game_state',
  {
    title: 'Состояние игры',
    description:
      'Проверяет установку Juno: New Origins, запущена ли игра, активное сохранение и ключевые настройки. ' +
      'Вызывайте перед любой записью: писать при запущенной игре нельзя.',
    inputSchema: {},
  },
  guard(async () => {
    const s = await gameStatus();
    const lines = [
      s.installed ? `Игра установлена, версия ${s.gameVersion} (Unity ${s.unityVersion})` : 'Игра НЕ найдена',
      s.running ? `Запущена (pid ${s.pid}) — запись запрещена` : 'Не запущена — запись разрешена',
    ];
    if (s.craftCount !== undefined) lines.push(`Крафтов в сохранении: ${s.craftCount}`);
    if (s.activeGameStateId !== undefined) lines.push(`Активное сохранение: ${s.activeGameStateId}`);
    if (s.optimizeCraftXML !== undefined)
      lines.push(
        `optimizeCraftXML: ${s.optimizeCraftXML} ${s.optimizeCraftXML ? '(игра минифицирует крафты; для сверки диффов выключите)' : ''}`
      );
    if (s.modSupportEnabled !== undefined) lines.push(`Поддержка модов: ${s.modSupportEnabled}`);
    lines.push(
      s.installedMods.length > 0
        ? `Установленные моды: ${s.installedMods.join(', ')}`
        : 'Моды не установлены — мост недоступен, работаем через файлы'
    );
    if (s.logLastWrite !== undefined) lines.push(`Player.log обновлён: ${s.logLastWrite}`);
    if (s.warnings.length > 0) lines.push('', 'Предупреждения:', ...s.warnings.map((w) => `  ! ${w}`));
    return text(lines.join('\n'));
  })
);

// --- Крафты ---

server.registerTool(
  'craft_list',
  {
    title: 'Список крафтов',
    description: 'Перечисляет сохранённые конструкции с размером и числом деталей.',
    inputSchema: { pattern: z.string().optional().describe('Подстрока для фильтра по имени') },
  },
  guard(async ({ pattern }: { pattern?: string }) => {
    const p = await gamePaths();
    const files = (await readdir(p.craftDesigns)).filter(
      (f) => f.endsWith('.xml') && !f.startsWith('__partIcons__')
    );
    const rows: string[] = [];
    for (const f of files.sort()) {
      const name = f.replace(/\.xml$/, '');
      if (pattern !== undefined && !name.toLowerCase().includes(pattern.toLowerCase())) continue;
      const full = join(p.craftDesigns, f);
      const st = await stat(full);
      // Деталей считаем дешёвым способом: полный разбор 2-мегабайтного файла
      // ради одной цифры не оправдан.
      const partCount = (await readFile(full, 'utf8')).split('<Part ').length - 1;
      rows.push(
        `  ${name.padEnd(40)} ${String(partCount).padStart(4)} дет.  ${(st.size / 1024).toFixed(0).padStart(5)} КБ`
      );
    }
    return text(rows.length > 0 ? `Крафты (${rows.length}):\n${rows.join('\n')}` : 'Крафтов не найдено');
  })
);

const MAX_XML_PARTS = 50;
const MAX_XML_BYTES = 200_000;

server.registerTool(
  'craft_read',
  {
    title: 'Прочитать крафт',
    description:
      'Читает конструкцию. По умолчанию отдаёт сводку: ступени, двигатели, топливо, программы полёта. ' +
      'Режим tree показывает дерево деталей, xml — сырой XML только для указанных деталей ' +
      '(крафты доходят до 2 МБ, поэтому целиком XML не отдаётся никогда).',
    inputSchema: {
      name: z.string().describe('Имя крафта без .xml'),
      mode: z.enum(['summary', 'tree', 'xml']).default('summary'),
      part_ids: z.array(z.number()).optional().describe('Обязателен для mode=xml'),
      max_depth: z.number().optional().describe('Глубина дерева для mode=tree'),
    },
  },
  guard(
    async ({
      name,
      mode = 'summary',
      part_ids,
      max_depth,
    }: {
      name: string;
      mode?: 'summary' | 'tree' | 'xml';
      part_ids?: number[];
      max_depth?: number;
    }) => {
      const path = await craftPath(name);
      const raw = await readFile(path, 'utf8');
      const craft = Craft.parse(raw);

      if (mode === 'summary') return text(renderSummary(await summarize(craft, raw.length)));
      if (mode === 'tree') return text(renderTree(craft, max_depth ?? 99));

      if (part_ids === undefined || part_ids.length === 0)
        throw new ToolError(
          'part_ids_required',
          'Для mode=xml нужно указать part_ids. Найдите нужные детали через mode=tree или mode=summary.',
          { partCount: craft.parts.length }
        );
      if (part_ids.length > MAX_XML_PARTS)
        throw new ToolError(
          'too_many_parts',
          `Запрошено ${part_ids.length} деталей, максимум ${MAX_XML_PARTS}.`,
          {}
        );

      const chunks: string[] = [];
      const missing: number[] = [];
      for (const id of part_ids) {
        const part = craft.part(id);
        if (part === undefined) {
          missing.push(id);
          continue;
        }
        chunks.push(buildXml(part.node, { ...GAME_FORMAT, declaration: false, bom: false }));
      }
      for (const c of craft.connections)
        if (part_ids.includes(c.partA) && part_ids.includes(c.partB))
          chunks.push(buildXml(c.node, { ...GAME_FORMAT, declaration: false, bom: false }));

      let out = chunks.join('\n');
      if (out.length > MAX_XML_BYTES) out = `${out.slice(0, MAX_XML_BYTES)}\n… обрезано`;
      if (missing.length > 0) out = `(деталей нет в крафте: ${missing.join(', ')})\n${out}`;
      return text(out);
    }
  )
);

server.registerTool(
  'craft_build',
  {
    title: 'Собрать конструкцию',
    description:
      'Собирает аппарат из декларативной спецификации: стек деталей снизу вверх. ' +
      'Сам считает координаты, подбирает точки крепления по добытым рецептам, ' +
      'вычисляет ёмкость баков и разбивает детали на физические тела по отделителям. ' +
      'Виды элементов: pod, tank, engine, decoupler, nosecone, parachute, raw.',
    inputSchema: {
      spec: z
        .object({
          name: z.string(),
          type: z.enum(['rocket', 'plane']).optional(),
          stack: z.array(z.any()).describe('Снизу вверх: элемент 0 стоит на площадке'),
          activation_groups: z.array(z.string()).optional(),
        })
        .describe(
          'Пример: { "name":"Зонд", "stack":[ {"kind":"engine","nozzle":"Bravo","stage":0}, ' +
            '{"kind":"tank","length":5,"diameter":2}, {"kind":"pod"}, {"kind":"parachute","stage":1} ] }'
        ),
      dry_run: z.boolean().optional().describe('Только показать результат, не записывая'),
      force: z.boolean().optional(),
    },
  },
  guard(
    async ({
      spec,
      dry_run,
      force,
    }: {
      spec: CraftSpec;
      dry_run?: boolean;
      force?: boolean;
    }) => {
      const result = await buildCraft(spec);
      const lines = [
        `Собрано: «${spec.name}», ${result.partCount} деталей`,
        '',
        'Раскладка (снизу вверх, координата центра по Y):',
        ...result.layout.map(
          (l) =>
            `  ${String(l.id).padStart(2)}  ${l.partType.padEnd(16)} y=${String(l.y).padStart(8)}  h=${l.height}${l.stage > 0 ? `  ступень ${l.stage}` : ''}`
        ),
      ];
      if (result.warnings.length > 0)
        lines.push('', 'Предупреждения:', ...result.warnings.map((w) => `  ! ${w.message}`));

      if (dry_run === true) {
        lines.push('', '--- XML ---', result.xml.replace(/\r/g, ''));
        return text(lines.join('\n'));
      }

      const path = await craftPath(spec.name);
      const snap = await guardedWrite('craft_build', path, result.xml, { force });
      lines.push('', `Записано: ${path}`, `Снимок для отката: ${snap.id}`);
      return text(lines.join('\n'));
    }
  )
);

// --- Справочник деталей ---

server.registerTool(
  'part_lookup',
  {
    title: 'Справка по деталям',
    description:
      'Ищет типы деталей и показывает их точки крепления, модификаторы и добытые из готовых ' +
      'крафтов рецепты соединений. Вызывайте перед ручной правкой <Connection>.',
    inputSchema: {
      query: z.string().optional().describe('Подстрока имени или id'),
      id: z.string().optional().describe('Точный partType, например Fuselage1'),
      category: z.string().optional(),
    },
  },
  guard(
    async ({ query, id, category }: { query?: string; id?: string; category?: string }) => {
      const cat = await partsCatalog();

      if (id !== undefined) {
        const pt = await partType(id);
        if (pt === undefined) {
          const near = Object.keys(cat.parts)
            .filter((k) => k.toLowerCase().includes(id.toLowerCase().slice(0, 5)))
            .slice(0, 5);
          throw new ToolError('unknown_part_type', `Тип детали «${id}» не найден.`, {
            suggestions: near,
          });
        }
        const lines = [
          `${pt.id} — ${pt.name}${pt.procedural ? ' (процедурная: геометрия задаётся модификатором)' : ''}`,
          pt.categories.length > 0 ? `Категории: ${pt.categories.join(', ')}` : '',
          '',
          'Точки крепления (индексы для attachPointsA/B):',
          ...pt.attachPoints.map(
            (a) =>
              `  ${a.index}  ${a.kind.padEnd(8)} ${a.name}${a.tag !== undefined ? ` тег=${a.tag}` : ''}` +
              `${a.position !== undefined ? ` поз=${a.position.join(',')}` : ''}`
          ),
          '',
          `Модификаторы: ${Object.keys(pt.modifiers).join(', ')}`,
        ];

        const conn = (await connections()).connections[pt.id];
        if (conn !== undefined) {
          lines.push('', 'Известные рецепты соединений (добыты из готовых крафтов):');
          for (const [other, entry] of Object.entries(conn).slice(0, 14)) {
            const bits: string[] = [];
            if (entry.stack) bits.push(`стек a="${entry.stack.a}" b="${entry.stack.b}" (${entry.stack.seen}×)`);
            if (entry.surface)
              bits.push(`поверхность a="${entry.surface.a}" b="${entry.surface.b}" (${entry.surface.seen}×)`);
            if (bits.length > 0) lines.push(`  → ${other}: ${bits.join('; ')}`);
          }
        }
        if (pt.designerParts.length > 0)
          lines.push(
            '',
            `Пресеты в редакторе: ${pt.designerParts.map((d) => d.name).slice(0, 12).join(', ')}`
          );
        return text(lines.filter((l) => l !== '').join('\n'));
      }

      const q = (query ?? '').toLowerCase();
      const matches = Object.values(cat.parts).filter((pt) => {
        if (category !== undefined && !pt.categories.includes(category)) return false;
        if (q === '') return true;
        return (
          pt.id.toLowerCase().includes(q) ||
          pt.name.toLowerCase().includes(q) ||
          pt.designerParts.some((d) => d.name.toLowerCase().includes(q))
        );
      });
      if (matches.length === 0) return text(`Ничего не найдено по запросу «${query ?? category}»`);
      return text(
        `Найдено ${matches.length}:\n` +
          matches
            .map((pt) => `  ${pt.id.padEnd(22)} ${pt.name}${pt.procedural ? ' [процедурная]' : ''}`)
            .join('\n')
      );
    }
  )
);

// --- Vizzy ---

async function craftPropertySet(): Promise<Set<string>> {
  const root = process.env.JUNO_PLUGIN_ROOT ?? join(import.meta.dirname, '..', '..');
  const blocks = JSON.parse(
    await readFile(join(root, 'catalog', 'vizzy-blocks.json'), 'utf8')
  ) as { craftProperties: Record<string, string> };
  return new Set(Object.keys(blocks.craftProperties));
}

server.registerTool(
  'vizzy_read',
  {
    title: 'Прочитать программу полёта',
    description:
      'Читает Vizzy-программу — из отдельного файла или встроенную в деталь крафта — ' +
      'и отдаёт её в компактном DSL вместо многословного XML.',
    inputSchema: {
      file: z.string().optional().describe('Имя файла в UserData/FlightPrograms без .xml'),
      craft: z.string().optional().describe('Имя крафта со встроенной программой'),
      part_id: z.number().optional().describe('Деталь крафта, несущая программу'),
    },
  },
  guard(
    async ({ file, craft, part_id }: { file?: string; craft?: string; part_id?: number }) => {
      const p = await gamePaths();
      if (file !== undefined) {
        const path = join(p.flightPrograms, `${assertSafeName(file, 'Имя программы')}.xml`);
        const program = parseXmlRoot(await readFile(path, 'utf8'), 'Program');
        return text(JSON.stringify(decompileProgram(program), null, 2));
      }
      if (craft === undefined)
        throw new ToolError('missing_source', 'Укажите file или craft + part_id.', {});

      const parsed = Craft.parse(await readFile(await craftPath(craft), 'utf8'));
      const candidates = parsed.parts.filter((x) => x.modifiers.includes('FlightProgram'));
      const target =
        part_id !== undefined ? parsed.part(part_id) : candidates[0];
      if (target === undefined)
        throw new ToolError('no_program', 'В крафте нет детали с программой полёта.', {
          candidates: candidates.map((c) => c.id),
        });

      const program = target.node.children
        .find((c) => c.tag === 'FlightProgram')
        ?.children.find((c) => c.tag === 'Program');
      if (program === undefined)
        throw new ToolError('empty_program', `У детали ${target.id} есть вычислитель, но программа пуста.`, {});
      return text(JSON.stringify(decompileProgram(program), null, 2));
    }
  )
);

const dslSchema = z
  .object({
    name: z.string(),
    variables: z
      .array(z.object({ name: z.string(), value: z.union([z.number(), z.string(), z.boolean()]).optional() }))
      .optional(),
    on: z.record(z.array(z.any())),
    requiresMfd: z.boolean().optional(),
  })
  .describe(
    'Программа в DSL: { name, on: { FlightStart: [ ["set-input","throttle",1], ["stage"] ] } }. ' +
      'Выражения — массивы: ["<", ["prop","Altitude.ASL"], 1000]. "$имя" ссылается на переменную.'
  );

server.registerTool(
  'vizzy_write',
  {
    title: 'Записать программу полёта',
    description:
      'Компилирует программу из DSL в Vizzy XML и сохраняет — отдельным файлом или встроив в деталь крафта. ' +
      'Сам расставляет id и style. Перед записью делает снапшот.',
    inputSchema: {
      program: dslSchema,
      file: z.string().optional().describe('Сохранить как отдельный файл'),
      craft: z.string().optional().describe('Встроить в крафт'),
      part_id: z.number().optional().describe('Деталь-вычислитель; по умолчанию активный командный модуль'),
      dry_run: z.boolean().optional().describe('Только скомпилировать и показать XML'),
      force: z.boolean().optional().describe('Писать даже при запущенной игре — не используйте без разрешения'),
    },
  },
  guard(
    async ({
      program,
      file,
      craft,
      part_id,
      dry_run,
      force,
    }: {
      program: DslProgram;
      file?: string;
      craft?: string;
      part_id?: number;
      dry_run?: boolean;
      force?: boolean;
    }) => {
      const props = await craftPropertySet();
      const compiled = compileProgram(program, props);

      if (dry_run === true)
        return text(buildXml(compiled, GAME_FORMAT).replace(/\r/g, ''));

      const p = await gamePaths();

      if (file !== undefined) {
        const path = join(p.flightPrograms, `${assertSafeName(file, 'Имя программы')}.xml`);
        const snap = await guardedWrite('vizzy_write', path, buildXml(compiled, GAME_FORMAT), { force });
        return text(`Программа «${program.name}» записана в ${path}\nСнимок для отката: ${snap.id}`);
      }

      if (craft === undefined)
        throw new ToolError('missing_target', 'Укажите file или craft.', {});

      const path = await craftPath(craft);
      const parsed = Craft.parse(await readFile(path, 'utf8'));
      const target =
        part_id !== undefined
          ? parsed.part(part_id)
          : parsed.parts.find((x) => x.modifiers.includes('FlightProgram')) ??
            parsed.parts.find((x) => x.modifiers.includes('CommandPod'));
      if (target === undefined)
        throw new ToolError(
          'no_computer',
          'В крафте нет детали, способной нести программу (командный модуль, диск, чип или MFD).',
          {}
        );

      let holder = target.node.children.find((c) => c.tag === 'FlightProgram');
      if (holder === undefined) {
        holder = { tag: 'FlightProgram', attrs: {}, children: [] };
        target.node.children.push(holder);
      }
      holder.children = holder.children.filter((c) => c.tag !== 'Program');
      holder.children.push(compiled);

      const snap = await guardedWrite('vizzy_write', path, parsed.serialize(), { force });
      return text(
        `Программа «${program.name}» встроена в деталь ${target.id} (${target.partType}) крафта «${craft}».\n` +
          `Снимок для отката: ${snap.id}`
      );
    }
  )
);

// --- Запуск игры и лог ---

server.registerTool(
  'game_launch',
  {
    title: 'Запустить игру',
    description: 'Запускает Juno и ждёт появления процесса.',
    inputSchema: {},
  },
  guard(async () => {
    const r = await launchGame();
    return text(
      r.alreadyRunning
        ? `Игра уже запущена (pid ${r.pid})`
        : r.pid !== undefined
          ? `Игра запущена (pid ${r.pid})`
          : 'Команда запуска отправлена, но процесс не появился за 15 с'
    );
  })
);

server.registerTool(
  'game_quit',
  {
    title: 'Закрыть игру',
    description: 'Просит игру завершиться. Нужно перед любой записью в файлы сохранения.',
    inputSchema: { force: z.boolean().optional().describe('Убить процесс вместо вежливого выхода') },
  },
  guard(async ({ force }: { force?: boolean }) => {
    const r = await quitGame(force ?? false);
    return text(r.wasRunning ? 'Игра закрыта' : 'Игра не была запущена');
  })
);

server.registerTool(
  'log_read',
  {
    title: 'Прочитать Player.log',
    description:
      'Читает лог игры. По умолчанию показывает только ошибки со стеками, схлопывая повторы — ' +
      'это основной канал обратной связи, пока не установлен мод-мост.',
    inputSchema: {
      lines: z.number().optional(),
      filter: z.enum(['all', 'errors', 'mods']).optional(),
    },
  },
  guard(async ({ lines, filter }: { lines?: number; filter?: 'all' | 'errors' | 'mods' }) => {
    const r = await readLog({ lines, filter });
    return text(`${r.path} (${r.totalLines} строк)\n\n${r.returned}`);
  })
);

// --- Откат ---

server.registerTool(
  'junoclaude_restore',
  {
    title: 'Откатить изменения',
    description: 'Показывает снимки, сделанные перед записями, и восстанавливает выбранный.',
    inputSchema: { snapshot_id: z.string().optional().describe('Без него — только список') },
  },
  guard(async ({ snapshot_id }: { snapshot_id?: string }) => {
    if (snapshot_id === undefined) {
      const all = await listSnapshots();
      if (all.length === 0) return text('Снимков нет — записей ещё не было.');
      return text(
        `Снимки (новые сверху):\n${all
          .slice(0, 25)
          .map((s) => `  ${s.id}\n      ${s.files.map((f) => f.path).join(', ')}`)
          .join('\n')}`
      );
    }
    const m = await restoreSnapshot(snapshot_id);
    return text(`Восстановлено из ${m.id}:\n${m.files.map((f) => `  ${f.path}`).join('\n')}`);
  })
);

await server.connect(new StdioServerTransport());
