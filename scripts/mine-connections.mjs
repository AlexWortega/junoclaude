#!/usr/bin/env node
// Добывает рецепты соединений из готовых крафтов.
//
// `attachPointsA/B` — списки индексов через запятую, а не одиночные значения:
// стыковка стека связывает пару Load (физический джойнт + топливо) и пару
// Shell (визуальный и аэродинамический шов). Вывести это из метаданных
// точек крепления нельзя — но можно посчитать частоты по файлам, которые
// игра написала сама. Это ground truth, а не рассуждение.

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import { gamePaths } from './paths.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arr = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Собирает крафты отовсюду, где игра их хранит. */
async function collectCraftFiles(paths) {
  const dirs = [paths.craftDesigns, paths.subassemblies];
  const files = [];
  for (const dir of dirs) {
    let entries;
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      // __partIcons__ и подобные служебные файлы не содержат настоящих сборок.
      if (e.endsWith('.xml') && !e.startsWith('__partIcons__')) files.push(join(dir, e));
    }
  }
  return files;
}

async function main() {
  const paths = await gamePaths();
  const files = await collectCraftFiles(paths);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    parseAttributeValue: false,
  });

  // typeA → typeB → "a|b" → count
  const tally = new Map();
  let craftCount = 0;
  let connectionCount = 0;
  const skipped = [];

  for (const file of files) {
    let doc;
    try {
      doc = parser.parse(await readFile(file, 'utf8'));
    } catch (e) {
      skipped.push(`${file}: ${e.message}`);
      continue;
    }
    const assembly = doc.Craft?.Assembly ?? doc.Subassembly?.Assembly;
    if (!assembly) continue;

    const typeById = new Map();
    for (const p of arr(assembly.Parts?.Part)) typeById.set(String(p.id), p.partType);

    for (const c of arr(assembly.Connections?.Connection)) {
      const ta = typeById.get(String(c.partA));
      const tb = typeById.get(String(c.partB));
      // Соединения без явных точек крепления (или с висячей ссылкой на деталь)
      // ничему нас не учат.
      if (!ta || !tb || c.attachPointsA === undefined || c.attachPointsB === undefined) continue;

      const key = `${c.attachPointsA}|${c.attachPointsB}`;
      if (!tally.has(ta)) tally.set(ta, new Map());
      const byB = tally.get(ta);
      if (!byB.has(tb)) byB.set(tb, new Map());
      const byKey = byB.get(tb);
      byKey.set(key, (byKey.get(key) ?? 0) + 1);
      connectionCount++;
    }
    craftCount++;
  }

  // Брать самый частый рецепт нельзя: у Fuselage1→Fuselage1 чаще всего
  // встречается поверхностное крепление (деталь прилеплена к боку), а вовсе
  // не стековая стыковка. Билдеру стека такой рецепт дал бы разваленный
  // крафт. Поэтому классифицируем каждый вариант по видам задействованных
  // точек и храним лучший в каждой категории.
  const catalog = JSON.parse(await readFile(join(ROOT, 'catalog', 'parts.json'), 'utf8'));

  const pointsOf = (type, list) => {
    const ap = catalog.parts[type]?.attachPoints;
    if (!ap) return null;
    const out = [];
    for (const raw of String(list).split(',')) {
      const i = Number(raw);
      if (!Number.isInteger(i) || i < 0 || i >= ap.length) return null;
      out.push(ap[i]);
    }
    return out;
  };

  /**
   * Классифицирует соединение:
   *   surface — деталь прилеплена к боку другой (радиальное крепление)
   *   stack   — торцевая стыковка, A снизу (её точки Top) и B сверху
   *   stack_inverted — та же стыковка, записанная в обратном порядке
   *   other   — всё прочее (шарниры, стойки, служебные точки)
   */
  const classify = (pa, pb) => {
    if (!pa || !pb) return 'other';
    if (pa.some((p) => p.kind === 'surface') || pb.some((p) => p.kind === 'surface'))
      return 'surface';
    const load = (pts) => pts.some((p) => p.kind === 'load');
    if (!load(pa) || !load(pb)) return 'other';
    const tagged = (pts, tag) => pts.some((p) => p.tag === tag);
    if (tagged(pa, 'Top') && tagged(pb, 'Bottom')) return 'stack';
    if (tagged(pa, 'Bottom') && tagged(pb, 'Top')) return 'stack_inverted';
    return 'other';
  };

  const connections = {};
  for (const [ta, byB] of tally) {
    connections[ta] = {};
    for (const [tb, byKey] of byB) {
      const variants = [...byKey.entries()]
        .map(([key, seen]) => {
          const [a, b] = key.split('|');
          return { a, b, seen, kind: classify(pointsOf(ta, a), pointsOf(tb, b)) };
        })
        .sort((x, y) => y.seen - x.seen);

      const entry = { variants: variants.slice(0, 8) };
      // Лучший вариант в каждой категории — то, что билдер спрашивает по имени.
      for (const kind of ['stack', 'surface', 'stack_inverted', 'other']) {
        const best = variants.find((v) => v.kind === kind);
        if (best) entry[kind] = { a: best.a, b: best.b, seen: best.seen };
      }
      connections[ta][tb] = entry;
    }
  }

  const out = {
    generated: new Date().toISOString(),
    gameVersion: paths.gameVersion,
    minedFrom: { craftFiles: craftCount, connections: connectionCount },
    connections,
  };
  await writeFile(join(ROOT, 'catalog', 'connections.json'), JSON.stringify(out, null, 2));

  const pairCount = Object.values(connections).reduce((n, m) => n + Object.keys(m).length, 0);
  console.error(
    `${craftCount} крафтов, ${connectionCount} соединений → ${pairCount} пар типов → catalog/connections.json`
  );
  if (skipped.length) console.error(`пропущено ${skipped.length} файлов с ошибками разбора`);

  const withStack = [];
  for (const [ta, byB] of Object.entries(connections))
    for (const [tb, e] of Object.entries(byB)) if (e.stack) withStack.push([ta, tb, e.stack]);
  withStack.sort((x, y) => y[2].seen - x[2].seen);
  console.error(`\nстековых рецептов: ${withStack.length}. Самые надёжные:`);
  for (const [ta, tb, s] of withStack.slice(0, 12))
    console.error(`  ${ta} → ${tb}:  a="${s.a}" b="${s.b}"  (${s.seen}×)`);
}

main().catch((e) => {
  console.error(e.stack);
  process.exit(1);
});
