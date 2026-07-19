// Таблица блоков Vizzy: удобные имена DSL → тег и style в XML.
//
// Строки style взяты из catalog/vizzy-blocks.json, добытого из программ,
// написанных самой игрой. Угадывать их нельзя: у одного тега SetCraftProperty
// больше десятка разных style, и подстановка неверного даёт программу,
// которую игра откажется открывать.

export interface ArgSpec {
  name: string;
  /** Подсказка при ошибке; проверку типов Vizzy делает сам. */
  kind?: 'number' | 'text' | 'bool' | 'any';
}

export interface InstructionSpec {
  tag: string;
  style: string;
  args: ArgSpec[];
  /** Блок содержит вложенное тело <Instructions>. */
  body?: boolean;
  /** Второе тело — ветка else у If. */
  elseBody?: boolean;
  /** Постоянные атрибуты, например input="throttle" у SetInput. */
  fixedAttrs?: Record<string, string>;
  /** Атрибуты, берущиеся из именованных полей вызова. */
  namedAttrs?: string[];
}

export interface ExpressionSpec {
  tag: string;
  style: string;
  args: ArgSpec[];
  fixedAttrs?: Record<string, string>;
}

const n = (name: string): ArgSpec => ({ name, kind: 'number' });
const any = (name: string): ArgSpec => ({ name, kind: 'any' });

export const INSTRUCTIONS: Record<string, InstructionSpec> = {
  'wait-seconds': { tag: 'WaitSeconds', style: 'wait-seconds', args: [n('секунды')] },
  'wait-until': { tag: 'WaitUntil', style: 'wait-until', args: [any('условие')] },
  stage: { tag: 'ActivateStage', style: 'activate-stage', args: [] },
  display: {
    tag: 'DisplayMessage',
    style: 'display',
    args: [any('текст'), n('секунды')],
  },
  'set-input': {
    tag: 'SetInput',
    style: 'set-input',
    args: [any('значение')],
    namedAttrs: ['input'],
  },
  'set-var': {
    tag: 'SetVariable',
    style: 'set-variable',
    args: [any('имя'), any('значение')],
  },
  'change-var': {
    tag: 'ChangeVariable',
    style: 'change-variable',
    args: [any('имя'), any('дельта')],
  },
  'set-activation-group': {
    tag: 'SetActivationGroup',
    style: 'set-activation-group',
    args: [n('группа'), any('состояние')],
  },
  'set-craft-property': {
    tag: 'SetCraftProperty',
    style: 'set-craft-property',
    args: [any('значение')],
    namedAttrs: ['property'],
  },
  'set-target': { tag: 'SetTarget', style: 'set-target', args: [any('цель')] },
  'lock-nav': { tag: 'LockNavSphere', style: 'lock-nav-sphere', args: [any('направление')] },
  broadcast: {
    tag: 'BroadcastMessage',
    style: 'broadcast-msg',
    args: [any('сообщение'), any('данные')],
  },
  comment: { tag: 'Comment', style: 'comment', args: [any('текст')] },
  if: { tag: 'If', style: 'if', args: [any('условие')], body: true },
  'if-else': { tag: 'If', style: 'if-else', args: [any('условие')], body: true, elseBody: true },
  while: { tag: 'While', style: 'while', args: [any('условие')], body: true },
  repeat: { tag: 'Repeat', style: 'repeat', args: [n('раз')], body: true },
  for: {
    tag: 'For',
    style: 'for',
    args: [any('от'), any('до'), any('шаг')],
    body: true,
    namedAttrs: ['var'],
  },
  break: { tag: 'Break', style: 'break', args: [] },
  call: {
    tag: 'CallCustomInstruction',
    style: 'call-custom-instruction',
    args: [],
    namedAttrs: ['call'],
  },
};

export const EXPRESSIONS: Record<string, ExpressionSpec> = {
  // Арифметика
  '+': { tag: 'BinaryOp', style: 'op-add', args: [any('a'), any('b')], fixedAttrs: { op: '+' } },
  '-': { tag: 'BinaryOp', style: 'op-sub', args: [any('a'), any('b')], fixedAttrs: { op: '-' } },
  '*': { tag: 'BinaryOp', style: 'op-mul', args: [any('a'), any('b')], fixedAttrs: { op: '*' } },
  '/': { tag: 'BinaryOp', style: 'op-div', args: [any('a'), any('b')], fixedAttrs: { op: '/' } },
  '%': { tag: 'BinaryOp', style: 'op-mod', args: [any('a'), any('b')], fixedAttrs: { op: '%' } },
  min: { tag: 'BinaryOp', style: 'op-min', args: [any('a'), any('b')], fixedAttrs: { op: 'min' } },
  max: { tag: 'BinaryOp', style: 'op-max', args: [any('a'), any('b')], fixedAttrs: { op: 'max' } },
  rand: {
    tag: 'BinaryOp',
    style: 'op-rand',
    args: [any('от'), any('до')],
    fixedAttrs: { op: 'rand' },
  },

  // Сравнения. Vizzy кодирует их односимвольно: = g l.
  '=': { tag: 'Comparison', style: 'op-eq', args: [any('a'), any('b')], fixedAttrs: { op: '=' } },
  '>': { tag: 'Comparison', style: 'op-gt', args: [any('a'), any('b')], fixedAttrs: { op: 'g' } },
  '<': { tag: 'Comparison', style: 'op-lt', args: [any('a'), any('b')], fixedAttrs: { op: 'l' } },

  and: { tag: 'BoolOp', style: 'op-and', args: [any('a'), any('b')], fixedAttrs: { op: 'and' } },
  or: { tag: 'BoolOp', style: 'op-or', args: [any('a'), any('b')], fixedAttrs: { op: 'or' } },
  not: { tag: 'Not', style: 'op-not', args: [any('значение')] },

  cond: {
    tag: 'Conditional',
    style: 'conditional',
    args: [any('условие'), any('тогда'), any('иначе')],
  },
  join: { tag: 'StringOp', style: 'join', args: [any('a'), any('b')], fixedAttrs: { op: 'join' } },
  contains: {
    tag: 'StringOp',
    style: 'contains',
    args: [any('строка'), any('подстрока')],
    fixedAttrs: { op: 'contains' },
  },
  vector: { tag: 'Vector', style: 'vector', args: [n('x'), n('y'), n('z')] },
};

/** Математические функции идут одним тегом с разным атрибутом function. */
export const MATH_FUNCTIONS = [
  'abs',
  'floor',
  'ceil',
  'round',
  'sqrt',
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'ln',
  'log10',
  'exp',
] as const;

export function mathFunctionSpec(fn: string): ExpressionSpec {
  return {
    tag: 'MathFunction',
    style: `math-${fn}`,
    args: [any('значение')],
    fixedAttrs: { function: fn },
  };
}

/** Событие → style; верхний уровень программы всегда начинается с события. */
export const EVENTS: Record<string, string> = {
  FlightStart: 'flight-start',
  ChangeSoi: 'change-soi',
  PartExplode: 'part-explode',
  ReceiveMessage: 'receive-msg',
  Docked: 'docked',
  Collision: 'collision',
};

/** Похожие имена — для подсказки «возможно, вы имели в виду». */
export function suggest(name: string, candidates: string[], limit = 3): string[] {
  const distance = (a: string, b: string): number => {
    const dp: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = dp[0] as number;
      dp[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = dp[j] as number;
        dp[j] = Math.min(
          (dp[j] as number) + 1,
          (dp[j - 1] as number) + 1,
          prev + (a[i - 1] === b[j - 1] ? 0 : 1)
        );
        prev = tmp;
      }
    }
    return dp[b.length] as number;
  };
  return candidates
    .map((c) => [c, distance(name.toLowerCase(), c.toLowerCase())] as const)
    .filter(([, d]) => d <= Math.max(2, Math.floor(name.length / 3)))
    .sort((x, y) => x[1] - y[1])
    .slice(0, limit)
    .map(([c]) => c);
}
