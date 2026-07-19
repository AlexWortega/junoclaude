// Порождение конструкции из декларативной спецификации.
//
// Модель описывает стек снизу вверх; билдер сам считает координаты, подбирает
// точки крепления по добытым рецептам и разбивает детали на физические тела.
// Всё, что игра пересчитывает при загрузке (масса, габариты, сопротивление),
// заполняется приблизительно — тратить усилия на его точность незачем.

import type { XmlNode } from '../xml.js';
import { buildXml, GAME_FORMAT } from '../xml.js';
import { resolveStackConnection, partType, type ResolvedConnection } from '../catalog.js';
import { fuelCapacity, fuselageOffset, round6, vecStr, type FuselageShape } from './geometry.js';
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

/** Габаритная высота элемента вдоль оси стека. */
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

/** Топливо, отличное от ракетного, игра помечает атрибутом fuelType. */
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
        // Нос сходится в точку — верхний торец нулевой.
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
    // Без этого двигатель не подчиняется рычагу тяги.
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
 * Дополняет деталь модификаторами, объявленными в её типе, но не выписанными
 * нами. Игра их **не подставляет**: командный модуль без своего `<FuelTank>`
 * роняет построение топливной системы с NullReferenceException в
 * `CraftFuelSources.Rebuild`. Наши значения имеют приоритет над умолчаниями.
 */
async function fillDefaultModifiers(typeId: string, existing: XmlNode[]): Promise<XmlNode[]> {
  const pt = await partType(typeId);
  if (pt === undefined) return existing;

  const present = new Set(existing.map((m) => m.tag));
  const out = [...existing];

  for (const [tag, defaults] of Object.entries(pt.modifiers)) {
    if (present.has(tag)) continue;
    // Config несёт полсотни служебных атрибутов, и игра заполняет их сама —
    // в сохранённых ею конструкциях он всегда краткий.
    if (tag === 'Config') continue;
    out.push(node(tag, { ...defaults }));
  }
  return out;
}

export async function buildCraft(spec: CraftSpec): Promise<BuildResult> {
  const warnings: BuildWarning[] = [];
  if (spec.stack.length === 0) throw new Error('Стек пуст: нужна хотя бы одна деталь');

  // Командный модуль делаем корневым: игра ожидает, что корень — управляющая
  // деталь, и от неё же считает достижимость остальных.
  const podIndex = spec.stack.findIndex((i) => i.kind === 'pod');
  if (podIndex < 0)
    warnings.push({
      code: 'no_command_pod',
      message: 'В стеке нет командного модуля — аппарат будет неуправляемым.',
    });
  const rootIndex = podIndex >= 0 ? podIndex : 0;

  for (const item of spec.stack) {
    const id = partTypeOf(item);
    if ((await partType(id)) === undefined)
      throw new Error(`Неизвестный тип детали «${id}». Проверьте через part_lookup.`);
  }

  // Раскладка снизу вверх: позиция детали — её центр.
  const layout: BuildResult['layout'] = [];
  const parts: XmlNode[] = [];
  let y = 0;

  for (const [index, item] of spec.stack.entries()) {
    const height = itemHeight(item);
    const centerY = y + height / 2;
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
    y += height;
  }

  // Командный модуль несёт названия групп активации.
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

  // Соединения соседних деталей стека.
  const connections: XmlNode[] = [];
  for (let i = 0; i + 1 < spec.stack.length; i++) {
    const lower = partTypeOf(spec.stack[i] as StackItem);
    const upper = partTypeOf(spec.stack[i + 1] as StackItem);
    let resolved: ResolvedConnection;
    try {
      resolved = await resolveStackConnection(lower, upper);
    } catch (e) {
      throw new Error(
        `Не удалось состыковать ${lower} (позиция ${i}) с ${upper} (позиция ${i + 1}): ${(e as Error).message}`
      );
    }
    if (resolved.confidence === 'inferred')
      warnings.push({
        code: 'inferred_connection',
        message:
          `Стыковка ${lower} → ${upper} выведена по тегам, а не взята из готовых конструкций. ` +
          `Проверьте её в редакторе: возможно, детали соединятся не так, как задумано.`,
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

  // Тела разрываются на отделителях: всё, что выше отделителя, — отдельное
  // физическое тело, иначе аппарат не разделится при отстреле ступени.
  const bodies: XmlNode[] = [];
  let bodyId = 1;
  let current: number[] = [];
  spec.stack.forEach((item, index) => {
    current.push(index);
    // Парашют тоже отделяемый — в эталонной конструкции он своё тело.
    const breaks = item.kind === 'decoupler' || item.kind === 'parachute';
    if (breaks || index === spec.stack.length - 1) {
      bodies.push(
        node('Body', {
          id: String(bodyId++),
          partIds: current.join(','),
          mass: '0',
          position: '0,0,0',
          rotation: '0,0,0',
          centerOfMass: '0,0,0',
        })
      );
      current = [];
    }
  });
  if (current.length > 0)
    bodies.push(
      node('Body', {
        id: String(bodyId++),
        partIds: current.join(','),
        mass: '0',
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
      // Габариты и стоимость игра пересчитает; даём разумную оценку.
      initialBoundsMin: vecStr([-maxRadius, 0, -maxRadius]),
      initialBoundsMax: vecStr([maxRadius, y, maxRadius]),
      price: '0',
      xmlVersion: '15',
      suppressCraftConfigWarnings: 'false',
      activeCommandPod: String(rootIndex),
      localCenterOfMass: vecStr([0, y / 2, 0]),
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
