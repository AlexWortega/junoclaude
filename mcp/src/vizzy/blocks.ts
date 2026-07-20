// The Vizzy block table: friendly DSL names → tag and style in the XML.
//
// The style strings come from catalog/vizzy-blocks.json, mined from programs
// the game wrote itself. They cannot be guessed: the single tag
// SetCraftProperty has over a dozen different styles, and substituting the
// wrong one produces a program the game refuses to open.

export interface ArgSpec {
  name: string;
  /** A hint shown on error; Vizzy does the type checking itself. */
  kind?: 'number' | 'text' | 'bool' | 'any';
}

export interface InstructionSpec {
  tag: string;
  style: string;
  args: ArgSpec[];
  /** The block contains a nested <Instructions> body. */
  body?: boolean;
  /** A second body — the else branch of If. */
  elseBody?: boolean;
  /** Constant attributes, for example input="throttle" on SetInput. */
  fixedAttrs?: Record<string, string>;
  /** Attributes taken from the named fields of the call. */
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
  'wait-seconds': { tag: 'WaitSeconds', style: 'wait-seconds', args: [n('seconds')] },
  'wait-until': { tag: 'WaitUntil', style: 'wait-until', args: [any('condition')] },
  stage: { tag: 'ActivateStage', style: 'activate-stage', args: [] },
  display: {
    tag: 'DisplayMessage',
    style: 'display',
    args: [any('text'), n('seconds')],
  },
  'set-input': {
    tag: 'SetInput',
    style: 'set-input',
    args: [any('value')],
    namedAttrs: ['input'],
  },
  'set-var': {
    tag: 'SetVariable',
    style: 'set-variable',
    args: [any('name'), any('value')],
  },
  'change-var': {
    tag: 'ChangeVariable',
    style: 'change-variable',
    args: [any('name'), any('delta')],
  },
  'set-activation-group': {
    tag: 'SetActivationGroup',
    style: 'set-activation-group',
    args: [n('group'), any('state')],
  },
  'set-craft-property': {
    tag: 'SetCraftProperty',
    style: 'set-craft-property',
    args: [any('value')],
    namedAttrs: ['property'],
  },
  'set-target': { tag: 'SetTarget', style: 'set-target', args: [any('target')] },
  // The game's own attitude hold. The direction is an attribute rather than an
  // argument: `["lock-nav", "Prograde"]`. Stock craft use Prograde, Retrograde,
  // Current and None, where None releases the hold.
  //
  // This is the game flying the craft for you. It removes the need for an
  // external attitude loop altogether — which is what the autopilot spent most
  // of its effort on, and badly.
  'lock-nav': {
    tag: 'LockNavSphere',
    style: 'lock-nav-sphere',
    args: [],
    namedAttrs: ['indicatorType'],
  },
  broadcast: {
    tag: 'BroadcastMessage',
    style: 'broadcast-msg',
    args: [any('message'), any('data')],
  },
  comment: { tag: 'Comment', style: 'comment', args: [any('text')] },
  if: { tag: 'If', style: 'if', args: [any('condition')], body: true },
  'if-else': { tag: 'If', style: 'if-else', args: [any('condition')], body: true, elseBody: true },
  while: { tag: 'While', style: 'while', args: [any('condition')], body: true },
  repeat: { tag: 'Repeat', style: 'repeat', args: [n('times')], body: true },
  for: {
    tag: 'For',
    style: 'for',
    args: [any('from'), any('to'), any('step')],
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
  // Arithmetic
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
    args: [any('from'), any('to')],
    fixedAttrs: { op: 'rand' },
  },

  // Comparisons. Vizzy encodes them as single characters: = g l.
  '=': { tag: 'Comparison', style: 'op-eq', args: [any('a'), any('b')], fixedAttrs: { op: '=' } },
  '>': { tag: 'Comparison', style: 'op-gt', args: [any('a'), any('b')], fixedAttrs: { op: 'g' } },
  '<': { tag: 'Comparison', style: 'op-lt', args: [any('a'), any('b')], fixedAttrs: { op: 'l' } },

  and: { tag: 'BoolOp', style: 'op-and', args: [any('a'), any('b')], fixedAttrs: { op: 'and' } },
  or: { tag: 'BoolOp', style: 'op-or', args: [any('a'), any('b')], fixedAttrs: { op: 'or' } },
  not: { tag: 'Not', style: 'op-not', args: [any('value')] },

  cond: {
    tag: 'Conditional',
    style: 'conditional',
    args: [any('condition'), any('then'), any('else')],
  },
  join: { tag: 'StringOp', style: 'join', args: [any('a'), any('b')], fixedAttrs: { op: 'join' } },
  contains: {
    tag: 'StringOp',
    style: 'contains',
    args: [any('string'), any('substring')],
    fixedAttrs: { op: 'contains' },
  },
  vector: { tag: 'Vector', style: 'vector', args: [n('x'), n('y'), n('z')] },
};

/** Math functions share a single tag and differ by the function attribute. */
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
    args: [any('value')],
    fixedAttrs: { function: fn },
  };
}

/** Event → style; the top level of a program always starts with an event. */
export const EVENTS: Record<string, string> = {
  FlightStart: 'flight-start',
  ChangeSoi: 'change-soi',
  PartExplode: 'part-explode',
  ReceiveMessage: 'receive-msg',
  Docked: 'docked',
  Collision: 'collision',
};

/** Similar names — for the "did you mean" hint. */
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
