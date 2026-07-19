#!/usr/bin/env node
// Builds catalog/parts.json from Assets/ModTools/Parts/Parts.xml inside ModTools.
//
// The script's main contribution is not a raw dump of attributes but deriving
// the `kind` field of each attach point. That is exactly what the builder's
// tag fallback relies on when a pair of parts has no mined recipe.

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import { extractByPathname } from './extract-unitypackage.mjs';
import { gamePaths } from './paths.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Classifies an attach point. The order of the checks matters: surface and
 * Shell points are recognised by explicit attributes, and everything else that
 * accepts no connections is internal (rotate).
 */
function classifyAttachPoint(a) {
  if (a.surface) return 'surface';
  if (a.connectionType === 'Shell') return 'shell';
  if (a.canReceive === 'false' || a.canReceive === false) return 'rotate';
  return 'load';
}

const num = (v) => (v === undefined ? undefined : Number(v));
const bool = (v) => v === 'true' || v === true;
const vec = (v) => (typeof v === 'string' ? v.split(',').map(Number) : undefined);

/** Coerces a fast-xml-parser value to an array (a single node arrives as an object). */
const arr = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function buildPart(partNode) {
  const pt = partNode.PartType;
  if (!pt) return null;

  const attachPoints = arr(pt.AttachPoints?.AttachPoint).map((a, index) => {
    const point = {
      index,
      name: a.name,
      display: a.displayName,
      kind: classifyAttachPoint(a),
    };
    if (a.tag) point.tag = a.tag;
    if (a.position) point.position = vec(a.position);
    if (a.rotation) point.rotation = vec(a.rotation);
    if (a.connectionType) point.connectionType = a.connectionType;
    if (a.surface) point.surface = a.surface;
    if (a.fuelLine !== undefined) point.fuelLine = bool(a.fuelLine);
    if (a.canReceive !== undefined) point.canReceive = bool(a.canReceive);
    if (a.allowRotation !== undefined) point.allowRotation = bool(a.allowRotation);
    if (a.jointType) point.jointType = a.jointType;
    return point;
  });

  // Modifiers are the child elements of <Modifiers>, where the tag name is the
  // modifier name and the attributes are its default values.
  const modifiers = {};
  for (const [tag, node] of Object.entries(pt.Modifiers ?? {})) {
    const first = Array.isArray(node) ? node[0] : node;
    modifiers[tag] = typeof first === 'object' && first !== null ? { ...first } : {};
  }

  const designerParts = arr(partNode.DesignerParts?.DesignerPart).map((d) => ({
    name: d.name,
    category: d.category,
    description: d.description,
    showInDesigner: bool(d.showInDesigner ?? 'true'),
  }));

  // A procedural part = its geometry comes from a modifier rather than a
  // prefab. The game always recomputes such parts on load, so mass/price in the
  // type definition are zeros and cannot be relied on.
  const procedural = 'Fuselage' in modifiers || 'Wing' in modifiers;

  return {
    id: pt.id,
    name: pt.name ?? partNode.name,
    prefabPath: pt.prefabPath,
    mass: num(pt.mass),
    price: num(pt.price),
    defaultMaterials: pt.defaultMaterials,
    procedural,
    categories: [...new Set(designerParts.map((d) => d.category).filter(Boolean))],
    attachPoints,
    modifiers,
    designerParts,
  };
}

async function main() {
  const paths = await gamePaths();
  const wanted = 'Assets/ModTools/Parts/Parts.xml';
  const files = await extractByPathname(paths.modToolsPackage, new Set([wanted]));

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    // Keep attributes as strings: they contain vectors ("0,-1,0") that a
    // numeric parser would corrupt.
    parseAttributeValue: false,
    trimValues: true,
  });
  const doc = parser.parse(files.get(wanted).toString('utf8'));

  const parts = {};
  for (const partNode of arr(doc.Parts?.Part)) {
    const built = buildPart(partNode);
    if (built?.id) parts[built.id] = built;
  }

  const catalog = {
    gameVersion: paths.gameVersion,
    unityVersion: paths.unityVersion,
    generated: new Date().toISOString(),
    source: wanted,
    partCount: Object.keys(parts).length,
    parts,
  };

  await mkdir(join(ROOT, 'catalog'), { recursive: true });
  const out = join(ROOT, 'catalog', 'parts.json');
  await writeFile(out, JSON.stringify(catalog, null, 2));

  const kinds = {};
  for (const p of Object.values(parts))
    for (const a of p.attachPoints) kinds[a.kind] = (kinds[a.kind] ?? 0) + 1;

  console.error(`${catalog.partCount} part types → catalog/parts.json`);
  console.error(`attach points by kind: ${JSON.stringify(kinds)}`);
  const proc = Object.values(parts).filter((p) => p.procedural).map((p) => p.id);
  console.error(`procedural: ${proc.length} — ${proc.join(', ')}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
