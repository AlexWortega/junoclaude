// Доступ к сгенерированным каталогам деталей и рецептов соединений.
//
// Каталоги собираются скриптами из scripts/ и коммитятся в репозиторий:
// установка плагина не запускает сборку, а без каталога билдер бесполезен.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AttachPoint {
  index: number;
  name: string;
  display?: string;
  /** surface — крепление к боку, load — торцевая нагрузка, shell — обшивка, rotate — служебная. */
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
  /** У процедурных деталей всегда 0 — массу игра выводит из модификаторов. */
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
 * Корень плагина. При запуске из Claude Code передаётся через JUNO_PLUGIN_ROOT;
 * иначе поднимаемся от dist/ — так работает и `node src/index.ts` в разработке.
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
      `Не удалось прочитать каталог ${path}: ${(e as Error).message}. ` +
        `Соберите его командой \`npm run catalog\` в корне плагина.`
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

/** Точки крепления по индексам из атрибута attachPointsA/B (это список!). */
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

export interface ResolvedConnection {
  a: string;
  b: string;
  /** known — рецепт добыт из готовых крафтов, inferred — выведен по тегам. */
  confidence: 'known' | 'inferred';
  seen?: number;
}

/**
 * Подбирает точки крепления для стыковки: `lower` стоит снизу, `upper` сверху.
 *
 * Сначала ищем добытый рецепт — это ground truth из файлов, которые игра
 * написала сама. Игра пишет соединение в обоих направлениях в зависимости от
 * того, как деталь ставили в редакторе, поэтому проверяем и обратную форму.
 * Только если рецепта нет — выводим пару по тегам, и такой результат
 * помечается как inferred, чтобы валидатор о нём предупредил.
 */
export async function resolveStackConnection(
  lower: string,
  upper: string
): Promise<ResolvedConnection> {
  const cat = await connections();

  const direct = cat.connections[lower]?.[upper]?.stack;
  if (direct) return { a: direct.a, b: direct.b, confidence: 'known', seen: direct.seen };

  // Обратная форма: в файле записано (upper, lower), где A — верхняя деталь.
  const inverted = cat.connections[upper]?.[lower]?.stack_inverted;
  if (inverted)
    return { a: inverted.b, b: inverted.a, confidence: 'known', seen: inverted.seen };

  const lowerPt = await partType(lower);
  const upperPt = await partType(upper);
  if (lowerPt === undefined || upperPt === undefined)
    throw new Error(`Неизвестный тип детали: ${lowerPt === undefined ? lower : upper}`);

  // Нижняя деталь стыкуется верхом, верхняя — низом. Берём пару Load и пару
  // Shell: только Load даст сегментированный корпус с неверным сопротивлением.
  const pick = (pt: PartType, tag: string, kind: AttachPoint['kind']): AttachPoint | undefined =>
    pt.attachPoints.find((p) => p.tag === tag && p.kind === kind);

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
  if (aIdx.length === 0)
    throw new Error(
      `Нет совместимых точек крепления: ${lower} (верх) → ${upper} (низ). ` +
        `Посмотрите part_lookup для обеих деталей.`
    );

  return { a: aIdx.join(','), b: bIdx.join(','), confidence: 'inferred' };
}

/** Точки для крепления детали к боковой поверхности другой. */
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
    throw new Error(`Неизвестный тип детали: ${attachedPt === undefined ? attached : host}`);

  // Прилепляемая деталь «тыкается» служебной точкой rotate, принимающая
  // подставляет surface.
  const a =
    attachedPt.attachPoints.find((p) => p.kind === 'rotate') ??
    attachedPt.attachPoints.find((p) => p.kind === 'load');
  const b = hostPt.attachPoints.find((p) => p.kind === 'surface');
  if (a === undefined || b === undefined)
    throw new Error(`Нельзя прикрепить ${attached} к поверхности ${host}: нет подходящих точек.`);

  return { a: String(a.index), b: String(b.index), confidence: 'inferred' };
}
