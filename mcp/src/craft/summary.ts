// Человекочитаемые сводки крафта.
//
// Крафты доходят до 2 МБ — отдать их модели целиком значит сжечь контекст на
// первом же вызове. Сводка и дерево рассчитаны так, чтобы самый большой
// стоковый крафт уложился в несколько килобайт.

import { type Craft, type PartRef, modifierAttr } from './model.js';
import { partType } from '../catalog.js';

const fmt = (n: number, digits = 1): string =>
  Number.isFinite(n) ? n.toFixed(digits).replace(/\.0+$/, '') : '?';

/** Двигатели описываем типом сопла: игра различает их только им. */
function engineLabel(p: PartRef): string {
  const nozzle = modifierAttr(p, 'RocketEngine', 'nozzleTypeId');
  if (nozzle !== undefined) return `ракетный (${nozzle})`;
  if (p.modifiers.includes('JetEngine')) return 'реактивный';
  if (p.partType === 'IonEngine1') return 'ионный';
  return 'двигатель';
}

export interface CraftSummary {
  name: string;
  xmlVersion: number;
  partCount: number;
  sizeBytes: number;
  rootPart?: string;
  stages: Array<{ stage: number; parts: number; engines: number; decouplers: number }>;
  engines: Array<{ id: number; type: string; stage: number }>;
  fuel: { tanks: number; totalCapacity: number; byType: Record<string, number> };
  commandPods: Array<{ id: number; partType: string; hasProgram: boolean }>;
  flightPrograms: Array<{ partId: number; name: string; instructionCount: number }>;
  controlSurfaces: number;
  wings: number;
  landingGear: number;
  orphanParts: number[];
  warnings: string[];
}

export async function summarize(craft: Craft, sizeBytes: number): Promise<CraftSummary> {
  const reachable = craft.reachableFromRoot();
  const orphans = craft.parts.filter((p) => !reachable.has(p.id)).map((p) => p.id);

  const engines = craft.parts
    .filter((p) => p.modifiers.some((m) => m === 'RocketEngine' || m === 'JetEngine'))
    .map((p) => ({ id: p.id, type: engineLabel(p), stage: p.activationStage }));

  const tanks = craft.parts.filter((p) => p.modifiers.includes('FuelTank'));
  const byType: Record<string, number> = {};
  let totalCapacity = 0;
  for (const t of tanks) {
    const cap = Number(modifierAttr(t, 'FuelTank', 'capacity') ?? '0');
    // Пустой fuelType означает обычное ракетное топливо.
    const kind = modifierAttr(t, 'FuelTank', 'fuelType') ?? 'Rocket';
    if (Number.isFinite(cap)) {
      totalCapacity += cap;
      byType[kind] = (byType[kind] ?? 0) + cap;
    }
  }

  const flightPrograms: CraftSummary['flightPrograms'] = [];
  for (const p of craft.parts) {
    const fp = p.node.children.find((c) => c.tag === 'FlightProgram');
    const program = fp?.children.find((c) => c.tag === 'Program');
    if (program === undefined) continue;
    const instructions = program.children.find((c) => c.tag === 'Instructions');
    flightPrograms.push({
      partId: p.id,
      name: program.attrs['name'] ?? '(без имени)',
      instructionCount: countInstructions(instructions),
    });
  }

  const stages = [...craft.stages().entries()].map(([stage, parts]) => ({
    stage,
    parts: parts.length,
    engines: parts.filter((p) => p.modifiers.some((m) => m === 'RocketEngine' || m === 'JetEngine'))
      .length,
    decouplers: parts.filter((p) => p.partType.startsWith('Detacher')).length,
  }));

  const warnings: string[] = [];
  if (orphans.length > 0)
    warnings.push(
      `${orphans.length} деталей не связаны с корневой — игра отбросит их при загрузке: ${orphans
        .slice(0, 10)
        .join(', ')}`
    );
  if (craft.rootPart === undefined) warnings.push('Ни одна деталь не помечена rootPart="true"');
  if (engines.length === 0) warnings.push('В крафте нет двигателей');

  const unknown: string[] = [];
  for (const id of new Set(craft.parts.map((p) => p.partType)))
    if ((await partType(id)) === undefined) unknown.push(id);
  if (unknown.length > 0)
    warnings.push(
      `Типы деталей отсутствуют в каталоге (возможно, из мода): ${unknown.join(', ')}`
    );

  return {
    name: craft.name,
    xmlVersion: craft.xmlVersion,
    partCount: craft.parts.length,
    sizeBytes,
    rootPart: craft.rootPart ? `${craft.rootPart.id} (${craft.rootPart.partType})` : undefined,
    stages,
    engines,
    fuel: { tanks: tanks.length, totalCapacity, byType },
    commandPods: craft.parts
      .filter((p) => p.modifiers.includes('CommandPod'))
      .map((p) => ({
        id: p.id,
        partType: p.partType,
        hasProgram: p.modifiers.includes('FlightProgram'),
      })),
    flightPrograms,
    controlSurfaces: craft.parts.filter((p) => p.modifiers.includes('ControlSurface')).length,
    wings: craft.parts.filter((p) => p.modifiers.includes('Wing')).length,
    landingGear: craft.parts.filter((p) => p.modifiers.includes('LandingGear')).length,
    orphanParts: orphans,
    warnings,
  };
}

function countInstructions(node: { children: Array<{ tag: string; children: unknown[] }> } | undefined): number {
  if (node === undefined) return 0;
  let n = 0;
  const walk = (kids: Array<{ tag: string; children: unknown[] }>): void => {
    for (const k of kids) {
      n++;
      walk(k.children as Array<{ tag: string; children: unknown[] }>);
    }
  };
  walk(node.children);
  return n;
}

/** Текстовая сводка — то, что видит модель. */
export function renderSummary(s: CraftSummary): string {
  const lines: string[] = [];
  lines.push(`Крафт «${s.name}» — ${s.partCount} деталей, ${(s.sizeBytes / 1024).toFixed(0)} КБ, xmlVersion=${s.xmlVersion}`);
  if (s.rootPart !== undefined) lines.push(`Корневая деталь: ${s.rootPart}`);

  if (s.stages.length > 0) {
    lines.push('', 'Ступени:');
    for (const st of s.stages) {
      const bits = [`${st.parts} дет.`];
      if (st.engines > 0) bits.push(`${st.engines} двиг.`);
      if (st.decouplers > 0) bits.push(`${st.decouplers} отделитель`);
      lines.push(`  ${st.stage}: ${bits.join(', ')}`);
    }
  }

  if (s.engines.length > 0) {
    lines.push('', `Двигатели (${s.engines.length}):`);
    // Группируем: у крупных крафтов десятки одинаковых двигателей.
    const grouped = new Map<string, number>();
    for (const e of s.engines) {
      const key = `${e.type}, ступень ${e.stage}`;
      grouped.set(key, (grouped.get(key) ?? 0) + 1);
    }
    for (const [key, n] of grouped) lines.push(`  ${n}× ${key}`);
  }

  if (s.fuel.tanks > 0) {
    const types = Object.entries(s.fuel.byType)
      .map(([k, v]) => `${k}: ${fmt(v, 0)}`)
      .join(', ');
    lines.push('', `Топливо: ${s.fuel.tanks} баков, всего ${fmt(s.fuel.totalCapacity, 0)} (${types})`);
  }

  const bits: string[] = [];
  if (s.wings > 0) bits.push(`крыльев ${s.wings}`);
  if (s.controlSurfaces > 0) bits.push(`рулевых поверхностей ${s.controlSurfaces}`);
  if (s.landingGear > 0) bits.push(`шасси ${s.landingGear}`);
  if (bits.length > 0) lines.push(`Аэродинамика: ${bits.join(', ')}`);

  if (s.commandPods.length > 0)
    lines.push(
      `Командные модули: ${s.commandPods.map((c) => `${c.id} (${c.partType})`).join(', ')}`
    );

  if (s.flightPrograms.length > 0) {
    lines.push('', 'Программы полёта:');
    for (const fp of s.flightPrograms)
      lines.push(`  деталь ${fp.partId}: «${fp.name}», ${fp.instructionCount} блоков`);
  }

  if (s.warnings.length > 0) {
    lines.push('', 'Предупреждения:');
    for (const w of s.warnings) lines.push(`  ! ${w}`);
  }
  return lines.join('\n');
}

/** Дерево деталей от корня — обход по графу соединений. */
export function renderTree(craft: Craft, maxDepth = 99, maxLines = 400): string {
  const start = craft.rootPart ?? craft.parts[0];
  if (start === undefined) return '(крафт без деталей)';

  const lines: string[] = [];
  const seen = new Set<number>([start.id]);
  let truncated = false;

  const label = (p: PartRef): string => {
    const bits = [`${p.id}`, p.partType];
    if (p.name !== undefined && p.name !== '') bits.push(`«${p.name}»`);
    if (p.activationStage > 0) bits.push(`ст.${p.activationStage}`);
    const interesting = p.modifiers.filter(
      (m) => !['Drag', 'Config', 'PartConnections'].includes(m)
    );
    if (interesting.length > 0) bits.push(`[${interesting.join(' ')}]`);
    return bits.join(' ');
  };

  const walk = (p: PartRef, depth: number, prefix: string): void => {
    if (lines.length >= maxLines) {
      truncated = true;
      return;
    }
    lines.push(`${prefix}${label(p)}`);
    if (depth >= maxDepth) return;
    for (const nId of craft.neighbours(p.id)) {
      if (seen.has(nId)) continue;
      const n = craft.part(nId);
      if (n === undefined) continue;
      seen.add(nId);
      walk(n, depth + 1, `${prefix}  `);
    }
  };
  walk(start, 0, '');

  const orphans = craft.parts.filter((p) => !seen.has(p.id));
  if (orphans.length > 0) {
    lines.push('', `Не связаны с корнем (${orphans.length}):`);
    for (const p of orphans.slice(0, 20)) lines.push(`  ${label(p)}`);
    if (orphans.length > 20) lines.push(`  … ещё ${orphans.length - 20}`);
  }
  if (truncated) lines.push('', `… вывод обрезан на ${maxLines} строках`);
  return lines.join('\n');
}
