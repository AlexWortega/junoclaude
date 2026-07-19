// Generating a design from a declarative spec.
//
// The model describes the stack bottom-up; the builder works out the
// coordinates itself, picks attach points from mined recipes and splits parts
// into physical bodies. Everything the game recomputes on load (mass, bounds,
// drag) is filled in approximately — there is no point spending effort on its
// accuracy.

import type { XmlNode } from '../xml.js';
import { buildXml, GAME_FORMAT } from '../xml.js';
import { resolveStackConnection, partType, type ResolvedConnection } from '../catalog.js';
import {
  fuelCapacity,
  fuselageOffset,
  fuselageVolume,
  round6,
  vecStr,
  type FuselageShape,
} from './geometry.js';
import type { XmlNode as Node } from '../xml.js';

export type StackItem =
  | { kind: 'pod'; variant?: string; name?: string }
  | { kind: 'tank'; length: number; diameter: number; top_diameter?: number; fuel?: string; stage?: number }
  | { kind: 'engine'; nozzle?: string; size?: number; stage?: number; name?: string }
  | { kind: 'decoupler'; diameter: number; stage: number }
  | { kind: 'nosecone'; diameter: number; length?: number }
  | { kind: 'parachute'; stage: number }
  | { kind: 'raw'; partType: string; length?: number; modifiers?: Record<string, Record<string, string | number>>; stage?: number };

export interface CraftSpec {
  name: string;
  type?: 'rocket' | 'plane';
  stack: StackItem[];
  activation_groups?: string[];
}

export interface BuildWarning {
  code: string;
  message: string;
}

export interface BuildResult {
  xml: string;
  partCount: number;
  warnings: BuildWarning[];
  layout: Array<{ id: number; partType: string; y: number; height: number; stage: number }>;
}

const node = (tag: string, attrs: Record<string, string> = {}, children: XmlNode[] = []): XmlNode => ({
  tag,
  attrs,
  children,
});

/** Overall height of an item along the stack axis. */
function itemHeight(item: StackItem): number {
  switch (item.kind) {
    case 'pod':
      return 1.6;
    case 'tank':
      return item.length;
    case 'engine':
      return 1.0 * (item.size ?? 1);
    case 'decoupler':
      return 0.35;
    case 'nosecone':
      return item.length ?? item.diameter;
    case 'parachute':
      return 0.5;
    case 'raw':
      return item.length ?? 1;
  }
}

function partTypeOf(item: StackItem): string {
  switch (item.kind) {
    case 'pod':
      return item.variant ?? 'CommandPod1';
    case 'tank':
      return 'Fuselage1';
    case 'engine':
      return 'RocketEngine1';
    case 'decoupler':
      return 'Detacher1';
    case 'nosecone':
      return 'NoseCone1';
    case 'parachute':
      return 'Parachute1';
    case 'raw':
      return item.partType;
  }
}

/** Fuel other than rocket fuel is marked by the game with a fuelType attribute. */
const FUEL_TYPES = new Set(['Jet', 'Battery', 'Mono', 'Solid', 'LOX/LH2', 'LOX/CH4', 'Xenon']);

function modifiersFor(item: StackItem): XmlNode[] {
  const out: XmlNode[] = [
    node('Drag', { drag: '0,0,0,0,0,0', area: '0,0,0,0,0,0' }),
    node('Config', {}),
  ];

  if (item.kind === 'tank') {
    const halfTop = (item.top_diameter ?? item.diameter) / 2;
    const halfBottom = item.diameter / 2;
    const shape: FuselageShape = {
      length: item.length,
      topScale: [halfTop, halfTop],
      bottomScale: [halfBottom, halfBottom],
    };
    out.push(
      node('Fuselage', {
        bottomScale: `${round6(halfBottom)},${round6(halfBottom)}`,
        topScale: `${round6(halfTop)},${round6(halfTop)}`,
        offset: fuselageOffset(item.length),
        deformations: '0,0,0',
        depthCurve: '0',
        version: '3',
      })
    );

    if (item.fuel !== 'empty') {
      const solid = item.fuel === 'Solid';
      const capacity = round6(fuelCapacity(shape, { solid }));
      const attrs: Record<string, string> = {
        capacity: String(capacity),
        fuel: String(capacity),
      };
      if (item.fuel !== undefined && FUEL_TYPES.has(item.fuel)) attrs['fuelType'] = item.fuel;
      out.push(node('FuelTank', attrs));
    }
  }

  if (item.kind === 'nosecone') {
    const half = item.diameter / 2;
    out.push(
      node('Fuselage', {
        bottomScale: `${round6(half)},${round6(half)}`,
        // A nose cone converges to a point — its top face is zero.
        topScale: '0,0',
        offset: fuselageOffset(item.length ?? item.diameter),
        version: '3',
      })
    );
  }

  if (item.kind === 'decoupler') {
    const half = item.diameter / 2;
    out.push(
      node('Fuselage', {
        bottomScale: `${round6(half)},${round6(half)}`,
        topScale: `${round6(half)},${round6(half)}`,
        offset: fuselageOffset(0.35),
        version: '3',
      })
    );
    out.push(node('Detacher', {}));
  }

  if (item.kind === 'engine') {
    const attrs: Record<string, string> = { nozzleTypeId: item.nozzle ?? 'Bravo' };
    if (item.size !== undefined) attrs['nozzleThroatSize'] = String(round6(item.size * 0.85));
    out.push(node('RocketEngine', attrs));
    // Without this the engine does not respond to the throttle.
    out.push(node('InputController', { inputId: 'Throttle' }));
  }

  if (item.kind === 'parachute') out.push(node('Parachute', {}));

  if (item.kind === 'raw' && item.modifiers !== undefined)
    for (const [tag, attrs] of Object.entries(item.modifiers)) {
      const stringified: Record<string, string> = {};
      for (const [k, v] of Object.entries(attrs)) stringified[k] = String(v);
      out.push(node(tag, stringified));
    }

  return out;
}

/**
 * Fills in the modifiers a part's type declares but we did not write out. The
 * game does **not** supply them: a command pod without its own `<FuelTank>`
 * crashes the fuel system build with a NullReferenceException in
 * `CraftFuelSources.Rebuild`. Our values take priority over the defaults.
 */
async function fillDefaultModifiers(typeId: string, existing: XmlNode[]): Promise<XmlNode[]> {
  const pt = await partType(typeId);
  if (pt === undefined) return existing;

  const present = new Set(existing.map((m) => m.tag));
  const out = [...existing];

  for (const [tag, defaults] of Object.entries(pt.modifiers)) {
    if (present.has(tag)) continue;
    // Config carries some fifty internal attributes and the game fills them in
    // itself — in the designs it saves it is always terse.
    if (tag === 'Config') continue;
    out.push(node(tag, { ...defaults }));
  }
  return out;
}

/**
 * A rough estimate of a part group's mass. The game recomputes the exact value
 * anyway, but it must not be handed a zero — a degenerate body is thrown out on
 * spawn. A tank's dry mass is taken as a fraction of the fuel volume so the
 * order of magnitude matches what the game computes itself.
 */
function estimateGroupMass(partIds: number[], stack: StackItem[]): number {
  let mass = 0;
  for (const id of partIds) {
    const item = stack[id];
    if (item === undefined) continue;
    switch (item.kind) {
      case 'tank': {
        const half = item.diameter / 2;
        const shape: FuselageShape = {
          length: item.length,
          topScale: [half, half],
          bottomScale: [half, half],
        };
        mass += fuselageVolume(shape) * 12;
        break;
      }
      case 'engine':
        mass += 8 * (item.size ?? 1);
        break;
      case 'pod':
        mass += 100;
        break;
      case 'parachute':
        mass += 4.5;
        break;
      case 'decoupler':
        mass += 5;
        break;
      default:
        mass += 2;
    }
  }
  return Math.max(mass, 1);
}

export async function buildCraft(spec: CraftSpec): Promise<BuildResult> {
  const warnings: BuildWarning[] = [];
  if (spec.stack.length === 0) throw new Error('The stack is empty: at least one part is required');

  // Make the command pod the root: the game expects the root to be the
  // controlling part, and measures the reachability of the rest from it.
  const podIndex = spec.stack.findIndex((i) => i.kind === 'pod');
  if (podIndex < 0)
    warnings.push({
      code: 'no_command_pod',
      message: 'The stack has no command pod — the vehicle will be uncontrollable.',
    });
  const rootIndex = podIndex >= 0 ? podIndex : 0;

  for (const item of spec.stack) {
    const id = partTypeOf(item);
    if ((await partType(id)) === undefined)
      throw new Error(`Unknown part type "${id}". Check it with part_lookup.`);
  }

  // Layout bottom-up: a part's position is its centre.
  //
  // The origin must end up at the centre of mass, not at the bottom of the
  // stack. The game positions a craft on the pad relative to its origin, so a
  // stack laid out from zero upward spawns buried in the ground and is
  // destroyed. This was established by letting the game re-save a generated
  // craft: it shifted every part by the same amount and wrote
  // localCenterOfMass equal to minus the root part's position.
  const heights = spec.stack.map(itemHeight);
  let cursor = 0;
  const rawCentres = heights.map((h) => {
    const centre = cursor + h / 2;
    cursor += h;
    return centre;
  });

  let massSum = 0;
  let momentSum = 0;
  spec.stack.forEach((item, index) => {
    const m = estimateGroupMass([index], spec.stack);
    massSum += m;
    momentSum += m * (rawCentres[index] as number);
  });
  const centreOfMass = massSum > 0 ? momentSum / massSum : cursor / 2;

  const layout: BuildResult['layout'] = [];
  const parts: XmlNode[] = [];
  const totalHeight = cursor;

  for (const [index, item] of spec.stack.entries()) {
    const height = heights[index] as number;
    const centerY = (rawCentres[index] as number) - centreOfMass;
    const stage = 'stage' in item && item.stage !== undefined ? item.stage : 0;

    const attrs: Record<string, string> = {
      id: String(index),
      partType: partTypeOf(item),
      position: vecStr([0, centerY, 0]),
      rotation: '0,0,0',
      commandPodId: String(rootIndex),
    };
    if (index === rootIndex) attrs['rootPart'] = 'true';
    if (stage > 0) attrs['activationStage'] = String(stage);
    if ('name' in item && item.name !== undefined) attrs['name'] = item.name;

    const modifiers = await fillDefaultModifiers(attrs['partType'] as string, modifiersFor(item));
    parts.push(node('Part', attrs, modifiers));
    layout.push({ id: index, partType: attrs['partType'] as string, y: round6(centerY), height, stage });
  }

  // The command pod carries the activation group names.
  if (spec.activation_groups !== undefined && podIndex >= 0) {
    const names = Array.from({ length: 10 }, (_, i) => spec.activation_groups?.[i] ?? '').join(',');
    const pod = parts[podIndex] as XmlNode;
    pod.children.push(
      node(
        'CommandPod',
        {
          activationGroupNames: names,
          activationGroupStates: Array(10).fill('false').join(','),
          craftConfigType: spec.type === 'plane' ? 'Plane' : 'Rocket',
        },
        [node('Controls', {})]
      )
    );
  }

  // Connections between adjacent parts of the stack.
  const connections: XmlNode[] = [];
  for (let i = 0; i + 1 < spec.stack.length; i++) {
    const lower = partTypeOf(spec.stack[i] as StackItem);
    const upper = partTypeOf(spec.stack[i + 1] as StackItem);
    let resolved: ResolvedConnection;
    try {
      resolved = await resolveStackConnection(lower, upper);
    } catch (e) {
      throw new Error(
        `Could not join ${lower} (position ${i}) to ${upper} (position ${i + 1}): ${(e as Error).message}`
      );
    }
    if (resolved.confidence === 'inferred')
      warnings.push({
        code: 'inferred_connection',
        message:
          `The joint ${lower} → ${upper} was derived from tags rather than taken from existing designs. ` +
          `Check it in the designer: the parts may connect differently than intended.`,
      });

    connections.push(
      node('Connection', {
        partA: String(i),
        partB: String(i + 1),
        attachPointsA: resolved.a,
        attachPointsB: resolved.b,
      })
    );
  }

  // A detachable part forms a physical body of its own, so the split goes
  // BEFORE it rather than after: otherwise a parachute last in the stack stuck
  // to the hull and the vehicle flew as a single body. Verified by comparing
  // with how the game re-saved our own design: it splits into
  // {engine, tank, pod} and {parachute}.
  const detachable = (item: StackItem): boolean =>
    item.kind === 'decoupler' || item.kind === 'parachute';

  const groups: number[][] = [];
  let current: number[] = [];
  spec.stack.forEach((item, index) => {
    if (detachable(item)) {
      if (current.length > 0) groups.push(current);
      groups.push([index]);
      current = [];
      return;
    }
    current.push(index);
  });
  if (current.length > 0) groups.push(current);

  const bodies: XmlNode[] = groups.map((partIds, i) =>
    node('Body', {
      id: String(i + 1),
      partIds: partIds.join(','),
      // The game recomputes mass on load, but the physics treats zero as a
      // degenerate body: a vehicle with zero mass is thrown out on spawn.
      mass: String(round6(estimateGroupMass(partIds, spec.stack))),
      position: '0,0,0',
      rotation: '0,0,0',
      centerOfMass: '0,0,0',
    })
  );

  const maxRadius = Math.max(
    0.5,
    ...spec.stack.map((i) =>
      i.kind === 'tank' || i.kind === 'nosecone' || i.kind === 'decoupler' ? i.diameter / 2 : 0.5
    )
  );

  const craft = node(
    'Craft',
    {
      name: spec.name,
      parent: '',
      // Bounds are in craft-local coordinates, whose origin now sits at the
      // centre of mass, so the bottom of the stack is negative.
      initialBoundsMin: vecStr([-maxRadius, -centreOfMass, -maxRadius]),
      initialBoundsMax: vecStr([maxRadius, totalHeight - centreOfMass, maxRadius]),
      price: '0',
      xmlVersion: '15',
      suppressCraftConfigWarnings: 'false',
      activeCommandPod: String(rootIndex),
      // Expressed relative to the root part: the origin is the centre of mass,
      // so this is simply minus the root's position.
      localCenterOfMass: vecStr([0, -((rawCentres[rootIndex] as number) - centreOfMass), 0]),
    },
    [
      node('Assembly', {}, [
        node('Parts', {}, parts),
        node('Connections', {}, connections),
        node('Collisions', {}),
        node('Bodies', {}, bodies),
      ]),
      node('DesignerSettings', {}),
      node('Themes', {}),
      node('Symmetry', {}),
    ]
  );

  return {
    xml: buildXml(craft, GAME_FORMAT),
    partCount: parts.length,
    warnings,
    layout,
  };
}

export type { Node };
