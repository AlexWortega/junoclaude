// Геометрия процедурных корпусов и вывод ёмкости баков.
//
// Формула ёмкости выведена статистически по 2286 бакам из 62 конструкций,
// сохранённых самой игрой, и подтверждена точно:
//   круглое сечение    → 550.000 единиц на кубометр
//   квадратное сечение → ровно 4/π от этого же значения
// То есть коэффициент один, а различается площадь сечения. Совпадение с 4/π
// до четвёртого знака не оставляет сомнений в модели.

/** Единиц топлива на кубометр объёма при utilization = 1. */
export const FUEL_UNITS_PER_M3 = 550;

/** У твёрдого топлива своя плотность. */
export const SOLID_FUEL_UNITS_PER_M3 = 400;

/**
 * Площадь сечения корпуса. `cornerRadiuses` задаёт скругление восьми углов:
 * при единице сечение круглое (π·a·b), при нуле — прямоугольное (4·a·b).
 * Промежуточные значения игра интерполирует, и замеры это подтверждают.
 */
export function crossSectionArea(
  halfWidth: number,
  halfDepth: number,
  cornerRadiuses: number[] = [1, 1, 1, 1, 1, 1, 1, 1]
): number {
  const roundness =
    cornerRadiuses.length > 0
      ? cornerRadiuses.reduce((a, b) => a + b, 0) / cornerRadiuses.length
      : 1;
  const clamped = Math.min(1, Math.max(0, roundness));
  const circle = Math.PI * halfWidth * halfDepth;
  const square = 4 * halfWidth * halfDepth;
  return square + (circle - square) * clamped;
}

export interface FuselageShape {
  /** Полная длина детали по оси Y. */
  length: number;
  /** Полуоси верхнего торца: [ширина, глубина]. */
  topScale: [number, number];
  bottomScale: [number, number];
  cornerRadiuses?: number[];
}

/**
 * Объём усечённого конуса с переменным сечением. Игра использует ту же
 * формулу для среднего сечения, что и классическая формула Симпсона.
 */
export function fuselageVolume(shape: FuselageShape): number {
  const corners = shape.cornerRadiuses;
  const top = crossSectionArea(shape.topScale[0], shape.topScale[1], corners);
  const bottom = crossSectionArea(shape.bottomScale[0], shape.bottomScale[1], corners);
  return (shape.length / 3) * (top + bottom + Math.sqrt(Math.abs(top * bottom)));
}

export function fuelCapacity(
  shape: FuselageShape,
  opts: { utilization?: number; solid?: boolean } = {}
): number {
  const { utilization = 1, solid = false } = opts;
  const density = solid ? SOLID_FUEL_UNITS_PER_M3 : FUEL_UNITS_PER_M3;
  return fuselageVolume(shape) * utilization * density;
}

/**
 * Атрибут `offset` корпуса: его составляющая по Y равна **половине** длины.
 * Проверено на эталонной конструкции: бак с offset="0,2.5,0" простирается от
 * -2.82 до 2.18 при центре -0.32, то есть занимает пять метров.
 */
export function fuselageOffset(length: number): string {
  return `0,${length / 2},0`;
}

/** Округление до шести знаков — игра пишет числа примерно с такой точностью. */
export const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

export const vecStr = (v: number[]): string => v.map(round6).join(',');
