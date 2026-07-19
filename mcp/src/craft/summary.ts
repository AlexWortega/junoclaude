// Human-readable craft summaries.
//
// Crafts reach 2 MB — handing one to the model whole burns the context on the
// very first call. The summary and the tree are sized so that the largest stock
// craft fits into a few kilobytes.

import { type Craft, type PartRef, modifierAttr } from './model.js';
import { partType } from '../catalog.js';

const fmt = (n: number, digits = 1): string =>
  Number.isFinite(n) ? n.toFixed(digits).replace(/\.0+$/, '') : '?';

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Engines are described by nozzle type: that is all the game distinguishes them by. */
function engineLabel(p: PartRef): string {
  const nozzle = modifierAttr(p, 'RocketEngine', 'nozzleTypeId');
  if (nozzle !== undefined) return `rocket (${nozzle})`;
  if (p.modifiers.includes('JetEngine')) return 'jet';
  if (p.partType === 'IonEngine1') return 'ion';
  return 'engine';
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
    // An empty fuelType means ordinary rocket fuel.
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
      name: program.attrs['name'] ?? '(unnamed)',
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
      `${plural(orphans.length, 'part')} not connected to the root — the game will drop them on load: ${orphans
        .slice(0, 10)
        .join(', ')}`
    );
  if (craft.rootPart === undefined) warnings.push('No part is marked rootPart="true"');
  if (engines.length === 0) warnings.push('The craft has no engines');

  const unknown: string[] = [];
  for (const id of new Set(craft.parts.map((p) => p.partType)))
    if ((await partType(id)) === undefined) unknown.push(id);
  if (unknown.length > 0)
    warnings.push(
      `Part types missing from the catalog (possibly from a mod): ${unknown.join(', ')}`
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

/** The text summary — this is what the model sees. */
export function renderSummary(s: CraftSummary): string {
  const lines: string[] = [];
  lines.push(`Craft "${s.name}" — ${plural(s.partCount, 'part')}, ${(s.sizeBytes / 1024).toFixed(0)} KB, xmlVersion=${s.xmlVersion}`);
  if (s.rootPart !== undefined) lines.push(`Root part: ${s.rootPart}`);

  if (s.stages.length > 0) {
    lines.push('', 'Stages:');
    for (const st of s.stages) {
      const bits = [plural(st.parts, 'part')];
      if (st.engines > 0) bits.push(`${st.engines} eng.`);
      if (st.decouplers > 0) bits.push(plural(st.decouplers, 'decoupler'));
      lines.push(`  ${st.stage}: ${bits.join(', ')}`);
    }
  }

  if (s.engines.length > 0) {
    lines.push('', `Engines (${s.engines.length}):`);
    // Group them: large crafts carry dozens of identical engines.
    const grouped = new Map<string, number>();
    for (const e of s.engines) {
      const key = `${e.type}, stage ${e.stage}`;
      grouped.set(key, (grouped.get(key) ?? 0) + 1);
    }
    for (const [key, n] of grouped) lines.push(`  ${n}× ${key}`);
  }

  if (s.fuel.tanks > 0) {
    const types = Object.entries(s.fuel.byType)
      .map(([k, v]) => `${k}: ${fmt(v, 0)}`)
      .join(', ');
    lines.push('', `Fuel: ${plural(s.fuel.tanks, 'tank')}, ${fmt(s.fuel.totalCapacity, 0)} total (${types})`);
  }

  const bits: string[] = [];
  if (s.wings > 0) bits.push(`wings ${s.wings}`);
  if (s.controlSurfaces > 0) bits.push(`control surfaces ${s.controlSurfaces}`);
  if (s.landingGear > 0) bits.push(`landing gear ${s.landingGear}`);
  if (bits.length > 0) lines.push(`Aerodynamics: ${bits.join(', ')}`);

  if (s.commandPods.length > 0)
    lines.push(
      `Command pods: ${s.commandPods.map((c) => `${c.id} (${c.partType})`).join(', ')}`
    );

  if (s.flightPrograms.length > 0) {
    lines.push('', 'Flight programs:');
    for (const fp of s.flightPrograms)
      lines.push(`  part ${fp.partId}: "${fp.name}", ${fp.instructionCount} blocks`);
  }

  if (s.warnings.length > 0) {
    lines.push('', 'Warnings:');
    for (const w of s.warnings) lines.push(`  ! ${w}`);
  }
  return lines.join('\n');
}

/** The part tree from the root — a walk over the connection graph. */
export function renderTree(craft: Craft, maxDepth = 99, maxLines = 400): string {
  const start = craft.rootPart ?? craft.parts[0];
  if (start === undefined) return '(craft with no parts)';

  const lines: string[] = [];
  const seen = new Set<number>([start.id]);
  let truncated = false;

  const label = (p: PartRef): string => {
    const bits = [`${p.id}`, p.partType];
    if (p.name !== undefined && p.name !== '') bits.push(`"${p.name}"`);
    if (p.activationStage > 0) bits.push(`st.${p.activationStage}`);
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
    lines.push('', `Not connected to the root (${orphans.length}):`);
    for (const p of orphans.slice(0, 20)) lines.push(`  ${label(p)}`);
    if (orphans.length > 20) lines.push(`  … ${orphans.length - 20} more`);
  }
  if (truncated) lines.push('', `… output truncated at ${maxLines} lines`);
  return lines.join('\n');
}
