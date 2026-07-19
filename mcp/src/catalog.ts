// Access to the generated catalogs of parts and connection recipes.
//
// The catalogs are built by the scripts in scripts/ and committed to the
// repository: installing the plugin does not run a build, and without a catalog
// the builder is useless.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AttachPoint {
  index: number;
  name: string;
  display?: string;
  /** surface — side attachment, load — end-on load, shell — skin, rotate — internal. */
  kind: 'surface' | 'load' | 'shell' | 'rotate';
  tag?: string;
  position?: number[];
  rotation?: number[];
  connectionType?: string;
  surface?: string;
  fuelLine?: boolean;
  canReceive?: boolean;
  allowRotation?: boolean;
  jointType?: string;
}

export interface DesignerPart {
  name: string;
  category?: string;
  description?: string;
  showInDesigner: boolean;
}

export interface PartType {
  id: string;
  name: string;
  prefabPath?: string;
  /** Always 0 for procedural parts — the game derives mass from the modifiers. */
  mass?: number;
  price?: number;
  defaultMaterials?: string;
  procedural: boolean;
  categories: string[];
  attachPoints: AttachPoint[];
  modifiers: Record<string, Record<string, string>>;
  designerParts: DesignerPart[];
}

export interface PartsCatalog {
  gameVersion?: string;
  unityVersion?: string;
  generated: string;
  partCount: number;
  parts: Record<string, PartType>;
}

export interface Recipe {
  a: string;
  b: string;
  seen: number;
}

export interface RecipeEntry {
  variants: Array<Recipe & { kind: string }>;
  stack?: Recipe;
  stack_inverted?: Recipe;
  surface?: Recipe;
  other?: Recipe;
}

export interface ConnectionsCatalog {
  generated: string;
  gameVersion?: string;
  minedFrom: { craftFiles: number; connections: number };
  connections: Record<string, Record<string, RecipeEntry>>;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The plugin root. When launched from Claude Code it arrives via
 * JUNO_PLUGIN_ROOT; otherwise we walk up from dist/ — which also makes
 * `node src/index.ts` work during development.
 */
function pluginRoot(): string {
  return process.env.JUNO_PLUGIN_ROOT ?? join(HERE, '..', '..');
}

let partsCache: PartsCatalog | undefined;
let connectionsCache: ConnectionsCatalog | undefined;

async function load<T>(file: string): Promise<T> {
  const path = join(pluginRoot(), 'catalog', file);
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (e) {
    throw new Error(
      `Could not read the catalog ${path}: ${(e as Error).message}. ` +
        `Build it with \`npm run catalog\` in the plugin root.`
    );
  }
}

export async function parts(): Promise<PartsCatalog> {
  partsCache ??= await load<PartsCatalog>('parts.json');
  return partsCache;
}

export async function connections(): Promise<ConnectionsCatalog> {
  connectionsCache ??= await load<ConnectionsCatalog>('connections.json');
  return connectionsCache;
}

export async function partType(id: string): Promise<PartType | undefined> {
  return (await parts()).parts[id];
}

/** Attach points by the indices in the attachPointsA/B attribute (it is a list!). */
export async function resolvePoints(
  typeId: string,
  list: string
): Promise<AttachPoint[] | undefined> {
  const pt = await partType(typeId);
  if (pt === undefined) return undefined;
  const out: AttachPoint[] = [];
  for (const raw of list.split(',')) {
    const i = Number(raw);
    const point = pt.attachPoints[i];
    if (!Number.isInteger(i) || point === undefined) return undefined;
    out.push(point);
  }
  return out;
}

/**
 * The side of the part an attach point belongs to. The `tag` attribute is only
 * filled in on some parts, whereas the point's name names the side almost
 * always: `AttachPointBottomLoad`, `AttachPointTop`. Relying on `tag` alone
 * means failing to connect a command pod to anything at all.
 */
function sideOf(point: AttachPoint): 'Top' | 'Bottom' | undefined {
  if (point.tag === 'Top' || point.tag === 'Bottom') return point.tag;
  const name = point.name;
  // Order matters: BottomLoad contains both Bottom and Load, but not Top.
  if (/bottom/i.test(name)) return 'Bottom';
  if (/top/i.test(name)) return 'Top';
  return undefined;
}

export interface ResolvedConnection {
  a: string;
  b: string;
  /** known — recipe mined from existing crafts, inferred — derived from tags. */
  confidence: 'known' | 'inferred';
  seen?: number;
}

/**
 * Picks the attach points for a stack joint: `lower` sits below, `upper` above.
 *
 * First look for a mined recipe — that is ground truth from files the game
 * wrote itself. The game records a connection in either direction depending on
 * how the part was placed in the designer, so we check the inverted form too.
 * Only when there is no recipe do we derive a pair from the tags, and such a
 * result is marked inferred so the validator can warn about it.
 */
export async function resolveStackConnection(
  lower: string,
  upper: string
): Promise<ResolvedConnection> {
  const cat = await connections();

  const direct = cat.connections[lower]?.[upper]?.stack;
  if (direct) return { a: direct.a, b: direct.b, confidence: 'known', seen: direct.seen };

  // Inverted form: the file records (upper, lower), where A is the upper part.
  const inverted = cat.connections[upper]?.[lower]?.stack_inverted;
  if (inverted)
    return { a: inverted.b, b: inverted.a, confidence: 'known', seen: inverted.seen };

  const lowerPt = await partType(lower);
  const upperPt = await partType(upper);
  if (lowerPt === undefined || upperPt === undefined)
    throw new Error(`Unknown part type: ${lowerPt === undefined ? lower : upper}`);

  // The lower part joins with its top, the upper one with its bottom. Take both
  // a Load pair and a Shell pair: Load alone gives a segmented hull with the
  // wrong drag.
  const pick = (
    pt: PartType,
    side: 'Top' | 'Bottom',
    kind: AttachPoint['kind']
  ): AttachPoint | undefined =>
    pt.attachPoints.find((p) => p.kind === kind && sideOf(p) === side);

  const aIdx: number[] = [];
  const bIdx: number[] = [];
  for (const kind of ['load', 'shell'] as const) {
    const a = pick(lowerPt, 'Top', kind);
    const b = pick(upperPt, 'Bottom', kind);
    if (a !== undefined && b !== undefined) {
      aIdx.push(a.index);
      bIdx.push(b.index);
    }
  }

  // Small parts such as a parachute have a single unnamed point — there is
  // nothing to choose between, and that is a valid joint, not a failure.
  if (aIdx.length === 0) {
    const soleLoad = (pt: PartType): AttachPoint | undefined => {
      const loads = pt.attachPoints.filter((p) => p.kind === 'load');
      return loads.length === 1 ? loads[0] : undefined;
    };
    const a = pick(lowerPt, 'Top', 'load') ?? soleLoad(lowerPt);
    const b = pick(upperPt, 'Bottom', 'load') ?? soleLoad(upperPt);
    if (a !== undefined && b !== undefined)
      return { a: String(a.index), b: String(b.index), confidence: 'inferred' };

    throw new Error(
      `No compatible attach points: ${lower} (top) → ${upper} (bottom). ` +
        `Check part_lookup for both parts.`
    );
  }

  return { a: aIdx.join(','), b: bIdx.join(','), confidence: 'inferred' };
}

/** Points for attaching a part to the side surface of another. */
export async function resolveSurfaceConnection(
  attached: string,
  host: string
): Promise<ResolvedConnection> {
  const cat = await connections();
  const direct = cat.connections[attached]?.[host]?.surface;
  if (direct) return { a: direct.a, b: direct.b, confidence: 'known', seen: direct.seen };

  const attachedPt = await partType(attached);
  const hostPt = await partType(host);
  if (attachedPt === undefined || hostPt === undefined)
    throw new Error(`Unknown part type: ${attachedPt === undefined ? attached : host}`);

  // The part being attached pokes with its internal rotate point, the receiving
  // one offers a surface point.
  const a =
    attachedPt.attachPoints.find((p) => p.kind === 'rotate') ??
    attachedPt.attachPoints.find((p) => p.kind === 'load');
  const b = hostPt.attachPoints.find((p) => p.kind === 'surface');
  if (a === undefined || b === undefined)
    throw new Error(`Cannot attach ${attached} to the surface of ${host}: no suitable points.`);

  return { a: String(a.index), b: String(b.index), confidence: 'inferred' };
}
