// Управление процессом игры и чтение её лога.
//
// Пока не установлен мод-мост, Player.log — единственный канал обратной связи
// из игры, поэтому его разбору уделено больше внимания, чем можно ожидать.

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { gamePaths } from './paths.js';
import { gamePid } from './safety.js';
import { parseXmlRoot, childNamed } from './xml.js';

const execAsync = promisify(exec);

export interface GameStatus {
  installed: boolean;
  running: boolean;
  pid?: number;
  gameVersion?: string;
  unityVersion?: string;
  appVersionLastRun?: string;
  activeGameStateId?: string;
  optimizeCraftXML?: boolean;
  modSupportEnabled?: boolean;
  skipMainMenu?: boolean;
  installedMods: string[];
  craftCount?: number;
  logLastWrite?: string;
  warnings: string[];
}

export async function gameStatus(): Promise<GameStatus> {
  const p = await gamePaths(true);
  const pid = await gamePid();
  const warnings: string[] = [];

  const status: GameStatus = {
    installed: p.installed,
    running: pid !== undefined,
    pid,
    gameVersion: p.gameVersion,
    unityVersion: p.unityVersion,
    installedMods: [],
    warnings,
  };

  if (!p.installed) {
    warnings.push(
      `Игра не найдена в ${p.installDir}. Задайте JUNO_INSTALL_DIR, если она установлена в другом месте.`
    );
    return status;
  }

  try {
    const root = parseXmlRoot(await readFile(p.settings, 'utf8'), 'Settings');
    status.activeGameStateId = root.attrs['gameStateId'];
    status.appVersionLastRun = root.attrs['appVersionLastRun'];

    const designer = childNamed(root, 'Designer');
    // Игра по умолчанию минифицирует craft XML, выбрасывая значения по
    // умолчанию. Для сверки сгенерированного крафта с тем, что игра сохранила,
    // это нужно отключить — иначе диффы нечитаемы.
    status.optimizeCraftXML = designer?.attrs['optimizeCraftXML'] !== 'false';

    const general = childNamed(root, 'General');
    status.skipMainMenu = general?.attrs['skipMainMenu'] === 'true';

    const mods = childNamed(root, 'Mods');
    status.modSupportEnabled = mods?.attrs['modSupportEnabled'] === 'true';
  } catch (e) {
    warnings.push(`Не удалось прочитать Settings.xml: ${(e as Error).message}`);
  }

  try {
    const { readdir } = await import('node:fs/promises');
    status.craftCount = (await readdir(p.craftDesigns)).filter(
      (f) => f.endsWith('.xml') && !f.startsWith('__')
    ).length;
  } catch {
    /* каталога может не быть на свежей установке */
  }

  try {
    const { readdir } = await import('node:fs/promises');
    status.installedMods = (await readdir(p.mods)).filter((f) => f.endsWith('.sr2-mod'));
  } catch {
    /* каталог модов создаётся игрой */
  }

  try {
    status.logLastWrite = (await stat(p.logPath)).mtime.toISOString();
  } catch {
    warnings.push('Player.log не найден — игра ещё ни разу не запускалась.');
  }

  if (
    status.appVersionLastRun !== undefined &&
    p.gameVersion !== undefined &&
    !status.appVersionLastRun.startsWith(p.gameVersion)
  )
    warnings.push(
      `Каталог собирался для версии ${p.gameVersion}, а последний запуск был ` +
        `${status.appVersionLastRun}. Возможно, форматы изменились — пересоберите каталог.`
    );

  return status;
}

export async function launchGame(): Promise<{ pid?: number; alreadyRunning: boolean }> {
  const existing = await gamePid();
  if (existing !== undefined) return { pid: existing, alreadyRunning: true };

  const p = await gamePaths();
  await execAsync(`open -a ${JSON.stringify(p.app)}`);

  // `open` возвращает управление до того, как процесс поднимется.
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const pid = await gamePid();
    if (pid !== undefined) return { pid, alreadyRunning: false };
  }
  return { alreadyRunning: false };
}

export async function quitGame(force = false): Promise<{ wasRunning: boolean }> {
  const pid = await gamePid();
  if (pid === undefined) return { wasRunning: false };

  if (force) {
    await execAsync(`kill -9 ${pid}`);
    return { wasRunning: true };
  }

  // Вежливый выход даёт игре сохранить состояние; убийство процесса потеряло бы
  // несохранённый полёт.
  await execAsync(`osascript -e 'tell application "SimpleRockets2" to quit'`).catch(async () => {
    await execAsync(`kill ${pid}`);
  });

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if ((await gamePid()) === undefined) return { wasRunning: true };
  }
  throw new Error(`Игра не завершилась за 20 с (pid ${pid}). Используйте force: true.`);
}

const ERROR_PATTERN =
  /(Exception|NullReference|Error:|ERROR|Failed to|Could not|Invalid|error CS\d+)/i;
/** Сколько строк после строки с ошибкой считать её стеком. */
const STACK_LINES = 12;

export interface LogResult {
  path: string;
  totalLines: number;
  returned: string;
  truncated: boolean;
}

export async function readLog(
  opts: { lines?: number; filter?: 'all' | 'errors' | 'mods' } = {}
): Promise<LogResult> {
  const { lines = 200, filter = 'errors' } = opts;
  const p = await gamePaths();
  const text = await readFile(p.logPath, 'utf8');
  const all = text.split('\n');

  if (filter === 'all') {
    const slice = all.slice(-lines);
    return {
      path: p.logPath,
      totalLines: all.length,
      returned: slice.join('\n'),
      truncated: all.length > lines,
    };
  }

  if (filter === 'mods') {
    const relevant = all.filter((l) => /mod/i.test(l));
    return {
      path: p.logPath,
      totalLines: all.length,
      returned:
        relevant.length > 0 ? relevant.slice(-lines).join('\n') : '(в логе нет упоминаний модов)',
      truncated: relevant.length > lines,
    };
  }

  // Ошибки без стека бесполезны, а повторяющиеся забивают вывод: собираем
  // каждую вместе с последующими строками и схлопываем одинаковые.
  const blocks: string[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < all.length; i++) {
    const line = all[i] as string;
    if (!ERROR_PATTERN.test(line)) continue;

    const block: string[] = [line];
    for (let j = i + 1; j < Math.min(i + 1 + STACK_LINES, all.length); j++) {
      const next = all[j] as string;
      // Стек кончился, когда пошёл текст, не похожий на кадр трассировки.
      if (next.trim() === '') break;
      if (ERROR_PATTERN.test(next)) break;
      block.push(next);
      if (!/^\s|^\s*at |^UnityEngine|^\s*[A-Za-z.]+\(/.test(next)) break;
    }
    i += block.length - 1;

    const signature = line.trim().slice(0, 160);
    const count = seen.get(signature) ?? 0;
    seen.set(signature, count + 1);
    if (count === 0) blocks.push(block.join('\n'));
  }

  const repeated = [...seen.entries()].filter(([, n]) => n > 1);
  const parts: string[] = [];
  if (blocks.length === 0) parts.push('(ошибок в логе не найдено)');
  else parts.push(blocks.slice(-lines).join('\n\n'));
  if (repeated.length > 0)
    parts.push(
      '',
      'Повторяющиеся ошибки:',
      ...repeated.map(([sig, n]) => `  ${n}× ${sig}`)
    );

  return {
    path: p.logPath,
    totalLines: all.length,
    returned: parts.join('\n'),
    truncated: blocks.length > lines,
  };
}
