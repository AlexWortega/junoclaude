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

/**
 * A ring of parts attached to the *side* of a stack item rather than stacked on
 * its end — landing legs, and eventually radial boosters.
 *
 * Stock craft place these on a circle at the parent's radius, each joining its
 * own attach point 0 to the parent's surface attach point (also 0 on a
 * `Fuselage1`), with the whole ring sharing one `symmetryId`. The azimuth shows
 * up twice: in the position, and inverted in the rotation.
 */
export interface RadialGroup {
  part: 'landing_leg';
  variant?: string;
  /** How many, spread evenly around the hull. */
  count?: number;
  /** Azimuth of the first one, in degrees. */
  angle?: number;
  /** Height on the parent, as a fraction of its length from the bottom. */
  height?: number;
  /** Outward tilt, in degrees; stock legs splay by about 25. */
  splay?: number;
  stage?: number;
}

export type StackItem =
  | { kind: 'pod'; variant?: string; name?: string }
  | { kind: 'tank'; length: number; diameter: number; top_diameter?: number; fuel?: string; stage?: number; radial?: RadialGroup[] }
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

/**
 * Where an item's own bottom and top attach points sit, relative to its
 * position, along the stack axis.
 *
 * This is what actually determines layout: a part is placed so its bottom
 * attach point coincides with the top attach point of the part below. Adding up
 * bounding boxes instead leaves gaps, and a joint stretched across a gap tears
 * apart under load.
 *
 * Verified against the stock reference rocket: its tank sits at y=-0.32 with a
 * half-length of 2.5, putting its bottom at -2.82 — and the engine sits at
 * exactly -2.82, because an engine attaches at its own origin rather than
 * offset by half its height.
 */
function attachOffsets(item: StackItem): { bottom: number; top: number } {
  switch (item.kind) {
    // Procedural hulls: their attach points are at ±1 in normalised
    // coordinates, scaled by the half-length set through the Fuselage modifier.
    case 'tank':
      return { bottom: -item.length / 2, top: item.length / 2 };
    case 'decoupler':
      return { bottom: -0.175, top: 0.175 };
    case 'nosecone': {
      const h = item.length ?? item.diameter;
      return { bottom: -h / 2, top: h / 2 };
    }
    // Fixed geometry, measured from the catalogue's attach points.
    case 'pod':
      return { bottom: -0.632, top: 0.632 };
    // An engine hangs below its single attach point and a parachute sits above
    // its own — both attach at their origin, not offset by half their height.
    case 'engine':
    case 'parachute':
      return { bottom: 0, top: 0 };
    case 'raw': {
      const h = item.length ?? 1;
      return { bottom: -h / 2, top: h / 2 };
    }
  }
}

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

    // The type definition declares a gyroscope with maxAcceleration="0", which
    // produces no torque at all: a craft carrying it cannot rotate, so neither
    // manual attitude commands nor the game's own LockNavSphere hold can turn
    // it. The game fills in a working value when a part is placed in the
    // designer — the stock reference rocket has maxAcceleration="1" and power
    // 97.7. Emitting the raw default silently produces an unsteerable vehicle.
    if (tag === 'Gyroscope') {
      out.push(
        node('Gyroscope', { ...defaults, maxAcceleration: '1', power: '97.65625' })
      );
      continue;
    }
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
    // Radial parts are numbered past the end of the stack; they carry a flat
    // estimate rather than a stack entry.
    if (item === undefined) {
      mass += 5;
      continue;
    }
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
  const offsets = spec.stack.map(attachOffsets);

  // Place each part so its bottom attach point meets the top attach point of
  // the part below. Summing bounding boxes would leave gaps between parts, and
  // a joint stretched over a gap tears apart in flight.
  const rawCentres: number[] = [];
  let joint = 0; // height of the joint currently being built on
  spec.stack.forEach((item, index) => {
    const off = offsets[index] as { bottom: number; top: number };
    const position = joint - off.bottom;
    rawCentres.push(position);
    joint = position + off.top;
  });

  // Bounds come from the parts' actual extents, since an engine reaches below
  // its attach point and a nose cone above its own.
  const extentLow = Math.min(
    ...rawCentres.map((c, i) => c - (heights[i] as number) / 2)
  );
  const extentHigh = Math.max(
    ...rawCentres.map((c, i) => c + (heights[i] as number) / 2)
  );
  const cursor = extentHigh - extentLow;

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
  const extraConnections: XmlNode[] = [];

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

  // Radial rings: legs and the like, attached to the side of a stack item.
  //
  // Each sits on a circle of the parent's radius. The azimuth appears twice and
  // in opposite senses — in the position as `(R cos θ, y, R sin θ)`, and in the
  // rotation as `90 - θ`, which is what stock craft do: a leg at θ=30° carries
  // rotation y=60, one at θ=-60° carries 150. The ring shares a `symmetryId`,
  // and every member joins its own attach point 0 to the parent's surface
  // attach point, which is also 0 on a `Fuselage1`.
  interface RadialPart {
    id: number;
    parent: number;
    mass: number;
    y: number;
  }
  const radialParts: RadialPart[] = [];

  for (const [index, item] of spec.stack.entries()) {
    if (item.kind !== 'tank' || item.radial === undefined) continue;
    for (const group of item.radial) {
      const count = group.count ?? 4;
      const variant = group.variant ?? 'LandingLeg4';
      if ((await partType(variant)) === undefined)
        throw new Error(`Unknown radial part type "${variant}". Check it with part_lookup.`);

      const radius = item.diameter / 2;
      const base = (rawCentres[index] as number) - item.length / 2 - centreOfMass;
      const y = base + item.length * (group.height ?? 0.12);
      const symmetryId = `jc-${index}-${radialParts.length}-${count}`;

      for (let k = 0; k < count; k++) {
        const theta = ((group.angle ?? 0) + (360 * k) / count) * (Math.PI / 180);
        const id = spec.stack.length + radialParts.length;
        const attrs: Record<string, string> = {
          id: String(id),
          partType: variant,
          position: vecStr([radius * Math.cos(theta), y, radius * Math.sin(theta)]),
          rotation: vecStr([
            group.splay ?? 25,
            90 - (theta * 180) / Math.PI,
            0,
          ]),
          commandPodId: String(rootIndex),
        };
        if (group.stage !== undefined && group.stage > 0)
          attrs['activationStage'] = String(group.stage);

        parts.push(node('Part', attrs, await fillDefaultModifiers(variant, [
          node('Drag', { drag: '0,0,0,0,0,0', area: '0,0,0,0,0,0' }),
          node('Config', {}),
        ])));
        layout.push({ id, partType: variant, y: round6(y), height: 1, stage: group.stage ?? 0 });
        radialParts.push({ id, parent: index, mass: 5, y });
        extraConnections.push(
          node('Connection', {
            partA: String(id),
            partB: String(index),
            attachPointsA: '0',
            attachPointsB: '0',
            symmetryId,
          })
        );
      }
    }
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

  // Which parts are joined, as index pairs (lower, upper). Normally these are
  // stack neighbours, but an upper stage engine is an exception.
  //
  // A decoupler never joins an engine directly — that pair occurs in none of
  // the 61 stock craft. `Detacher1` carries a `CoverEngine` modifier: the
  // interstage *encloses* the upper stage's engine and itself joins tank to
  // tank. The engine connects only to its own tank. So for the sequence
  // `decoupler, engine, tank` we join decoupler→tank and engine→tank, and skip
  // the decoupler→engine joint that has no physical counterpart.
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i + 1 < spec.stack.length; i++) {
    const here = spec.stack[i] as StackItem;
    const next = spec.stack[i + 1] as StackItem;
    const afterNext = spec.stack[i + 2];

    if (here.kind === 'decoupler' && next.kind === 'engine' && afterNext?.kind === 'tank') {
      pairs.push([i, i + 2]); // interstage to the tank it covers
      pairs.push([i + 1, i + 2]); // enclosed engine to that same tank
      i += 1; // the engine's own joint is already recorded
      continue;
    }
    pairs.push([i, i + 1]);
  }

  // Bodies are the stages, and a decoupler belongs to the stage it throws away:
  // it closes the group it sits on top of. Stock `__designerTutorialFirstOrbit__`
  // groups {5 engines, tank, Detacher(stage 1)} as one body and
  // {engine, tank, tank, Detacher(stage 2)} as the next — the interstage always
  // rides with the hardware below it, never alone.
  //
  // Giving a decoupler a body of its own made the game recompute it to *zero*
  // mass, leaving a massless rigid body between two heavy ones.
  //
  // A parachute is the exception and does form its own body: without the split
  // it stayed stuck to the hull and the vehicle flew as one piece.
  const groups: number[][] = [];
  let current: number[] = [];
  spec.stack.forEach((item, index) => {
    if (item.kind === 'parachute') {
      if (current.length > 0) groups.push(current);
      groups.push([index]);
      current = [];
      return;
    }
    current.push(index);
    if (item.kind === 'decoupler') {
      groups.push(current);
      current = [];
    }
  });
  if (current.length > 0) groups.push(current);

  // Which body each part ends up in, and where that body's centre of mass sits.
  // Both are needed before the connections are written, because a connection
  // that crosses a body boundary has to carry the joint that holds the two
  // bodies together.
  // A radial part is rigidly attached to its parent, so it belongs to the same
  // body: giving it one of its own would leave a near-massless body hanging off
  // the hull, which is exactly what tore the early multi-stage vehicles apart.
  for (const rp of radialParts) {
    const group = groups.find((g) => g.includes(rp.parent));
    if (group !== undefined) group.push(rp.id);
  }

  const bodyOfPart = new Map<number, number>();
  groups.forEach((partIds, i) => {
    for (const id of partIds) bodyOfPart.set(id, i + 1);
  });
  const groupCentre = groups.map((partIds) => {
    let m = 0;
    let moment = 0;
    for (const id of partIds) {
      const radial = radialParts.find((r) => r.id === id);
      const pm = radial === undefined ? estimateGroupMass([id], spec.stack) : radial.mass;
      // Radial parts are already positioned in craft coordinates; stack parts
      // still have to be shifted by the centre of mass. Mixing the two up put a
      // NaN in the body's position and the game refused the craft.
      const y = radial === undefined ? (rawCentres[id] as number) - centreOfMass : radial.y;
      m += pm;
      moment += pm * y;
    }
    return m > 0 ? moment / m : 0;
  });

  const connections: XmlNode[] = [];
  for (const [lowerIdx, upperIdx] of pairs) {
    const lower = partTypeOf(spec.stack[lowerIdx] as StackItem);
    const upper = partTypeOf(spec.stack[upperIdx] as StackItem);
    let resolved: ResolvedConnection;
    try {
      resolved = await resolveStackConnection(lower, upper);
    } catch (e) {
      throw new Error(
        `Could not join ${lower} (position ${lowerIdx}) to ${upper} (position ${upperIdx}): ${(e as Error).message}`
      );
    }
    if (resolved.confidence === 'inferred')
      warnings.push({
        code: 'inferred_connection',
        message:
          `The joint ${lower} → ${upper} was derived from tags rather than taken from existing designs. ` +
          `Check it in the designer: the parts may connect differently than intended.`,
      });

    const lowerBody = bodyOfPart.get(lowerIdx) as number;
    const upperBody = bodyOfPart.get(upperIdx) as number;
    const children: XmlNode[] = [];

    // A connection that crosses a body boundary carries the joint that holds
    // the two bodies together, as a nested <BodyJoint>. Leaving it out is what
    // made every multi-body vehicle fail: the game fell back to a default joint
    // that let the stack sag on the pad — the craft toppled to 54° before
    // ignition — and tear apart under thrust, with the decouplers still
    // reporting `activated: false`. Single-body vehicles were unaffected, which
    // is why the 4-part rocket flew to 26 km while every staged one did not.
    //
    // The anchor is the point where the two parts meet, expressed relative to
    // each body's own centre of mass. Both of the stock tutorial craft's joints
    // resolve to exactly that point from either side.
    if (lowerBody !== upperBody) {
      const anchor =
        (rawCentres[lowerIdx] as number) +
        attachOffsets(spec.stack[lowerIdx] as StackItem).top -
        centreOfMass;
      children.push(
        node('BodyJoint', {
          body: String(lowerBody),
          connectedBody: String(upperBody),
          // Copied from stock: a break force of 0 reads as "does not break",
          // and every stock joint uses the same large break torque.
          breakTorque: '1E+07',
          breakForce: '0',
          jointType: 'Normal',
          position: vecStr([0, anchor - (groupCentre[lowerBody - 1] as number), 0]),
          connectedPosition: vecStr([0, anchor - (groupCentre[upperBody - 1] as number), 0]),
          axis: '0,0,1',
          secondaryAxis: '0,1,0',
        })
      );
    }

    connections.push(
      node(
        'Connection',
        {
          partA: String(lowerIdx),
          partB: String(upperIdx),
          attachPointsA: resolved.a,
          attachPointsB: resolved.b,
        },
        children
      )
    );
  }

  connections.push(...extraConnections);

  const bodies: XmlNode[] = groups.map((partIds, i) =>
    node('Body', {
      id: String(i + 1),
      partIds: partIds.join(','),
      // The game recomputes mass on load, but the physics treats zero as a
      // degenerate body: a vehicle with zero mass is thrown out on spawn.
      mass: String(round6(estimateGroupMass(partIds, spec.stack))),
      // Stock writes the body's centre of mass here and leaves centerOfMass at
      // the origin; the joint anchors above are measured from this point.
      position: vecStr([0, groupCentre[i] as number, 0]),
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
      initialBoundsMin: vecStr([-maxRadius, extentLow - centreOfMass, -maxRadius]),
      initialBoundsMax: vecStr([maxRadius, extentHigh - centreOfMass, maxRadius]),
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
