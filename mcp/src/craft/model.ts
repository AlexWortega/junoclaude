// A craft model on top of the XML tree.
//
// The tree deliberately remains the source of truth: crafts reach 2 MB and
// carry dozens of modifiers we do not model and have no right to lose when
// rewriting. The model is an index over the tree, not a replacement for it.

import {
  type XmlNode,
  type XmlFormat,
  buildXml,
  childNamed,
  childrenNamed,
  parseXmlDocument,
} from '../xml.js';

export interface PartRef {
  id: number;
  partType: string;
  name?: string;
  position: number[];
  rotation: number[];
  activationStage: number;
  activationGroup?: number;
  isRoot: boolean;
  commandPodId?: number;
  /** Modifier names: FuelTank, RocketEngine, Wing, FlightProgram and so on. */
  modifiers: string[];
  node: XmlNode;
}

export interface ConnectionRef {
  partA: number;
  partB: number;
  attachPointsA?: string;
  attachPointsB?: string;
  node: XmlNode;
}

export class Craft {
  private constructor(
    readonly root: XmlNode,
    readonly format: XmlFormat,
    readonly parts: PartRef[],
    readonly connections: ConnectionRef[]
  ) {}

  static parse(text: string): Craft {
    const { root, format } = parseXmlDocument(text, 'Craft');
    const assembly = childNamed(root, 'Assembly');
    if (assembly === undefined) throw new Error('The craft has no <Assembly> element');

    const partsNode = childNamed(assembly, 'Parts');
    const parts: PartRef[] = [];
    for (const node of partsNode ? childrenNamed(partsNode, 'Part') : []) {
      const id = Number(node.attrs['id']);
      if (!Number.isInteger(id)) continue;
      parts.push({
        id,
        partType: node.attrs['partType'] ?? '',
        name: node.attrs['name'],
        position: vec(node.attrs['position']),
        rotation: vec(node.attrs['rotation']),
        // A missing attribute means stage zero — that is how the game saves space.
        activationStage: Number(node.attrs['activationStage'] ?? '0') || 0,
        activationGroup: node.attrs['activationGroup']
          ? Number(node.attrs['activationGroup'])
          : undefined,
        isRoot: node.attrs['rootPart'] === 'true',
        commandPodId: node.attrs['commandPodId']
          ? Number(node.attrs['commandPodId'])
          : undefined,
        modifiers: node.children.map((c) => c.tag),
        node,
      });
    }

    const connectionsNode = childNamed(assembly, 'Connections');
    const connections: ConnectionRef[] = [];
    for (const node of connectionsNode ? childrenNamed(connectionsNode, 'Connection') : []) {
      connections.push({
        partA: Number(node.attrs['partA']),
        partB: Number(node.attrs['partB']),
        attachPointsA: node.attrs['attachPointsA'],
        attachPointsB: node.attrs['attachPointsB'],
        node,
      });
    }

    return new Craft(root, format, parts, connections);
  }

  get name(): string {
    return this.root.attrs['name'] ?? '';
  }

  get xmlVersion(): number {
    return Number(this.root.attrs['xmlVersion'] ?? '0');
  }

  part(id: number): PartRef | undefined {
    return this.parts.find((p) => p.id === id);
  }

  get rootPart(): PartRef | undefined {
    return this.parts.find((p) => p.isRoot);
  }

  serialize(): string {
    return buildXml(this.root, this.format);
  }

  /** A part's neighbours in the connection graph — the tree walk follows them. */
  neighbours(id: number): number[] {
    const out: number[] = [];
    for (const c of this.connections) {
      if (c.partA === id) out.push(c.partB);
      else if (c.partB === id) out.push(c.partA);
    }
    return out;
  }

  /** Parts reachable from the root. The game drops everything else on load. */
  reachableFromRoot(): Set<number> {
    const seen = new Set<number>();
    const start = this.rootPart ?? this.parts[0];
    if (start === undefined) return seen;

    const queue = [start.id];
    seen.add(start.id);
    while (queue.length > 0) {
      const id = queue.pop() as number;
      for (const n of this.neighbours(id))
        if (!seen.has(n) && this.part(n) !== undefined) {
          seen.add(n);
          queue.push(n);
        }
    }
    return seen;
  }

  stages(): Map<number, PartRef[]> {
    const out = new Map<number, PartRef[]>();
    for (const p of this.parts) {
      const list = out.get(p.activationStage);
      if (list === undefined) out.set(p.activationStage, [p]);
      else list.push(p);
    }
    return new Map([...out.entries()].sort((a, b) => a[0] - b[0]));
  }
}

function vec(raw: string | undefined): number[] {
  if (raw === undefined) return [0, 0, 0];
  const parts = raw.split(',').map(Number);
  return parts.every(Number.isFinite) ? parts : [0, 0, 0];
}

/** The value of a part modifier's attribute, if that modifier is present. */
export function modifierAttr(
  part: PartRef,
  modifier: string,
  attr: string
): string | undefined {
  return part.node.children.find((c) => c.tag === modifier)?.attrs[attr];
}
