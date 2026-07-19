// The DSL → Vizzy XML compiler.
//
// Rules established by studying stock programs, and critical for the game to
// accept the result:
//   * only instructions get an id; expressions (<Constant>, <BinaryOp>…) have none
//   * ids follow document pre-order, starting from the event
//   * the top level of <Instructions> is a flat list: <Event> opens the stack
//     and the elements following it are its body, not nested children
//   * pos is needed by top-level blocks; the game lays them out itself, but
//     without it the blocks pile up on top of each other in the editor

import type { XmlNode } from '../xml.js';
import { buildXml, GAME_FORMAT } from '../xml.js';
import {
  EVENTS,
  EXPRESSIONS,
  INSTRUCTIONS,
  MATH_FUNCTIONS,
  mathFunctionSpec,
  suggest,
  type ExpressionSpec,
} from './blocks.js';

/** A DSL expression: a literal, "$variable", or ["operator", args…]. */
export type DslExpr = number | string | boolean | DslExpr[];

/** A DSL statement: ["operation", args…], with the body as a nested array. */
export type DslStmt = [string, ...unknown[]];

export interface DslProgram {
  name: string;
  variables?: Array<{ name: string; value?: number | string | boolean; list?: boolean }>;
  /** Event → a sequence of instructions. */
  on: Record<string, DslStmt[]>;
  requiresMfd?: boolean;
}

export class CompileError extends Error {
  constructor(
    message: string,
    public readonly path: string,
    public readonly hint?: string
  ) {
    super(message);
    this.name = 'CompileError';
  }
}

const node = (tag: string, attrs: Record<string, string> = {}, children: XmlNode[] = []): XmlNode => ({
  tag,
  attrs,
  children,
});

/** Vizzy writes numbers without exponential notation. */
function numText(v: number): string {
  if (!Number.isFinite(v)) throw new Error(`Non-numeric value: ${v}`);
  return Number.isInteger(v) ? String(v) : String(v);
}

class Compiler {
  private nextId = 0;
  private topY = -20;
  private readonly TOP_SPACING = 60;

  constructor(private readonly craftProperties: Set<string>) {}

  /** Expressions are not numbered — a rule verified against stock programs. */
  private expr(e: DslExpr, path: string): XmlNode {
    if (typeof e === 'number') return node('Constant', { number: numText(e) });
    if (typeof e === 'boolean') return node('Constant', { bool: String(e) });

    if (typeof e === 'string') {
      // "$name" is sugar for a variable reference; anything else is a text literal.
      if (e.startsWith('$'))
        return node('Variable', { list: 'false', local: 'true', variableName: e.slice(1) });
      return node('Constant', { text: e });
    }

    if (!Array.isArray(e) || e.length === 0)
      throw new CompileError(`Empty expression`, path);

    const [op, ...args] = e as [string, ...DslExpr[]];
    if (typeof op !== 'string')
      throw new CompileError(`An expression operator must be a string`, path);

    if (op === 'var') {
      const name = args[0];
      if (typeof name !== 'string')
        throw new CompileError(`var requires a variable name`, path);
      return node('Variable', { list: 'false', local: 'true', variableName: name });
    }

    if (op === 'prop') {
      const property = args[0];
      if (typeof property !== 'string')
        throw new CompileError(`prop requires a property name`, path);
      if (!this.craftProperties.has(property)) {
        const near = suggest(property, [...this.craftProperties]);
        throw new CompileError(
          `Unknown craft property "${property}"`,
          path,
          near.length > 0
            ? `Did you mean: ${near.join(', ')}`
            : `The list of properties is in the vizzy-blocks reference.`
        );
      }
      return node('CraftProperty', { property, style: this.propStyle(property) });
    }

    if ((MATH_FUNCTIONS as readonly string[]).includes(op))
      return this.applySpec(mathFunctionSpec(op), args, path, op);

    const spec = EXPRESSIONS[op];
    if (spec === undefined) {
      const near = suggest(op, [...Object.keys(EXPRESSIONS), ...MATH_FUNCTIONS, 'var', 'prop']);
      throw new CompileError(
        `Unknown operation "${op}"`,
        path,
        near.length > 0 ? `Did you mean: ${near.join(', ')}` : undefined
      );
    }
    return this.applySpec(spec, args, path, op);
  }

  private applySpec(
    spec: ExpressionSpec,
    args: DslExpr[],
    path: string,
    op: string
  ): XmlNode {
    if (args.length !== spec.args.length)
      throw new CompileError(
        `"${op}" expects ${spec.args.length} argument(s), got ${args.length}`,
        path,
        `Arguments: ${spec.args.map((a) => a.name).join(', ')}`
      );
    const attrs: Record<string, string> = { ...spec.fixedAttrs };
    if (spec.style !== '') attrs['style'] = spec.style;
    return node(
      spec.tag,
      attrs,
      args.map((a, i) => this.expr(a, `${path}.${op}[${i}]`))
    );
  }

  private propStyle(property: string): string {
    // The style is derived from the property group: Altitude.ASL → prop-altitude.
    const group = property.split('.')[0] ?? '';
    return `prop-${group.toLowerCase()}`;
  }

  private stmt(s: DslStmt, path: string, top: boolean): XmlNode {
    if (!Array.isArray(s) || s.length === 0)
      throw new CompileError(`Empty instruction`, path);
    const [op, ...rest] = s;
    if (typeof op !== 'string')
      throw new CompileError(`An instruction name must be a string`, path);

    const spec = INSTRUCTIONS[op];
    if (spec === undefined) {
      const near = suggest(op, Object.keys(INSTRUCTIONS));
      throw new CompileError(
        `Unknown instruction "${op}"`,
        path,
        near.length > 0 ? `Did you mean: ${near.join(', ')}` : undefined
      );
    }

    const attrs: Record<string, string> = { ...spec.fixedAttrs };

    // Named attributes (input on set-input, var on for) arrive as the first
    // positional arguments — that way the call reads like ordinary code.
    const named = spec.namedAttrs ?? [];
    const positional = [...rest];
    for (const attrName of named) {
      const value = positional.shift();
      if (typeof value !== 'string' && typeof value !== 'number')
        throw new CompileError(
          `"${op}" requires ${attrName} as its first argument`,
          path,
          `For example: ["${op}", "${attrName === 'input' ? 'throttle' : 'name'}", …]`
        );
      attrs[attrName] = String(value);
    }

    let body: DslStmt[] | undefined;
    let elseBody: DslStmt[] | undefined;
    if (spec.elseBody === true) elseBody = positional.pop() as DslStmt[] | undefined;
    if (spec.body === true) {
      const last = positional.pop();
      if (!Array.isArray(last))
        throw new CompileError(`"${op}" requires a body as its last argument (an array of instructions)`, path);
      body = last as DslStmt[];
    }

    if (positional.length !== spec.args.length)
      throw new CompileError(
        `"${op}" expects ${spec.args.length} argument(s) before the body, got ${positional.length}`,
        path,
        `Arguments: ${spec.args.map((a) => a.name).join(', ')}`
      );

    attrs['id'] = String(this.nextId++);
    attrs['style'] = spec.style;
    if (top) {
      attrs['pos'] = `-10,${this.topY}`;
      this.topY -= this.TOP_SPACING;
    }

    const children = positional.map((a, i) => this.expr(a as DslExpr, `${path}.${op}[${i}]`));

    // The game keeps comment text in a special kind of constant: it cannot be
    // replaced and is drawn differently. Without these attributes the editor
    // shows an ordinary input field.
    if (op === 'comment') {
      const first = children[0];
      if (first !== undefined && first.tag === 'Constant') {
        first.attrs = { style: 'comment-text', canReplace: 'false', ...first.attrs };
      }
    }

    if (body !== undefined)
      children.push(
        node(
          'Instructions',
          {},
          body.map((b, i) => this.stmt(b, `${path}.${op}.body[${i}]`, false))
        )
      );
    if (elseBody !== undefined)
      children.push(
        node(
          'Instructions',
          {},
          elseBody.map((b, i) => this.stmt(b, `${path}.${op}.else[${i}]`, false))
        )
      );

    return node(spec.tag, attrs, children);
  }

  compile(program: DslProgram): XmlNode {
    const variables = node(
      'Variables',
      {},
      (program.variables ?? []).map((v) => {
        const attrs: Record<string, string> = { name: v.name };
        if (typeof v.value === 'number') attrs['number'] = numText(v.value);
        else if (typeof v.value === 'boolean') attrs['bool'] = String(v.value);
        else if (typeof v.value === 'string') attrs['text'] = v.value;
        else attrs['number'] = '0';
        return node('Variable', attrs);
      })
    );

    const instructions: XmlNode[] = [];
    const events = Object.entries(program.on);
    if (events.length === 0)
      throw new CompileError(
        `The program contains no event handlers at all`,
        'on',
        `Add at least { "on": { "FlightStart": [...] } }`
      );

    for (const [eventName, body] of events) {
      const style = EVENTS[eventName];
      if (style === undefined) {
        const near = suggest(eventName, Object.keys(EVENTS));
        throw new CompileError(
          `Unknown event "${eventName}"`,
          `on.${eventName}`,
          `Available: ${Object.keys(EVENTS).join(', ')}${near.length > 0 ? `. Did you mean: ${near[0]}` : ''}`
        );
      }
      // An event and its body lie flat, one after another: <Event/> opens the
      // stack and the following elements continue it.
      instructions.push(
        node('Event', {
          event: eventName,
          id: String(this.nextId++),
          style,
          pos: `-10,${this.topY}`,
        })
      );
      this.topY -= this.TOP_SPACING;
      body.forEach((s, i) => instructions.push(this.stmt(s, `on.${eventName}[${i}]`, false)));
    }

    const attrs: Record<string, string> = { name: program.name };
    if (program.requiresMfd === true) attrs['requiresMfd'] = 'true';

    return node('Program', attrs, [
      variables,
      node('Instructions', {}, instructions),
      node('Expressions', {}),
    ]);
  }
}

export function compileProgram(program: DslProgram, craftProperties: Set<string>): XmlNode {
  return new Compiler(craftProperties).compile(program);
}

export function compileProgramToXml(program: DslProgram, craftProperties: Set<string>): string {
  return buildXml(compileProgram(program, craftProperties), GAME_FORMAT);
}
