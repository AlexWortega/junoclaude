#!/usr/bin/env node
// Строит catalog/parts.json из Assets/ModTools/Parts/Parts.xml внутри ModTools.
//
// Главный вклад скрипта — не сырой дамп атрибутов, а выведение поля `kind`
// у каждой точки крепления. Именно на него опирается tag-fallback в билдере,
// когда для пары деталей нет добытого рецепта.

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import { extractByPathname } from './extract-unitypackage.mjs';
import { gamePaths } from './paths.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Классифицирует точку крепления. Порядок проверок важен:
 * поверхностные и Shell-точки опознаются по явным атрибутам, а всё
 * остальное, что не принимает подключений, — служебное (rotate).
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

/** Приводит значение fast-xml-parser к массиву (одиночный узел приходит объектом). */
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

  // Модификаторы — это дочерние элементы <Modifiers>, где имя тега и есть
  // имя модификатора, а атрибуты — его значения по умолчанию.
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

  // Процедурная деталь = её геометрия задаётся модификатором, а не префабом.
  // Такие детали игра всегда пересчитывает при загрузке, поэтому mass/price
  // в определении типа стоят нулями и полагаться на них нельзя.
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
    // Атрибуты оставляем строками: в них встречаются векторы ("0,-1,0"),
    // которые числовой парсер испортил бы.
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

  console.error(`${catalog.partCount} типов деталей → catalog/parts.json`);
  console.error(`точки крепления по видам: ${JSON.stringify(kinds)}`);
  const proc = Object.values(parts).filter((p) => p.procedural).map((p) => p.id);
  console.error(`процедурных: ${proc.length} — ${proc.join(', ')}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
