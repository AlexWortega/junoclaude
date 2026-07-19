#!/usr/bin/env node
// Mines connection recipes from existing crafts.
//
// `attachPointsA/B` are comma-separated lists of indices, not single values: a
// stack joint links a Load pair (the physical joint + fuel) and a Shell pair
// (the visual and aerodynamic seam). This cannot be derived from attach point
// metadata — but the frequencies can be counted over files the game wrote
// itself. That is ground truth, not reasoning.

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import { gamePaths } from './paths.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arr = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Collects crafts from everywhere the game stores them. */
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
      // __partIcons__ and similar internal files contain no real assemblies.
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
      // Connections without explicit attach points (or with a dangling part
      // reference) teach us nothing.
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

  // Taking the most frequent recipe would be wrong: for Fuselage1→Fuselage1
  // the commonest one is a surface attachment (a part stuck to the side), not a
  // stack joint at all. Handing that recipe to the stack builder would produce
  // a craft that falls apart. So classify every variant by the kinds of points
  // involved and keep the best one in each category.
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
   * Classifies a connection:
   *   surface — a part stuck to the side of another (radial attachment)
   *   stack   — an end-on joint, A below (its Top points) and B above
   *   stack_inverted — the same joint recorded in the opposite order
   *   other   — everything else (hinges, struts, internal points)
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
      // The best variant in each category — what the builder asks for by name.
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
    `${craftCount} crafts, ${connectionCount} connections → ${pairCount} type pairs → catalog/connections.json`
  );
  if (skipped.length) console.error(`skipped ${skipped.length} files with parse errors`);

  const withStack = [];
  for (const [ta, byB] of Object.entries(connections))
    for (const [tb, e] of Object.entries(byB)) if (e.stack) withStack.push([ta, tb, e.stack]);
  withStack.sort((x, y) => y[2].seen - x[2].seen);
  console.error(`\nstack recipes: ${withStack.length}. The most reliable:`);
  for (const [ta, tb, s] of withStack.slice(0, 12))
    console.error(`  ${ta} → ${tb}:  a="${s.a}" b="${s.b}"  (${s.seen}×)`);
}

main().catch((e) => {
  console.error(e.stack);
  process.exit(1);
});
