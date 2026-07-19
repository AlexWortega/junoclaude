// The reverse transform, Vizzy XML → DSL.
//
// Needed so the model can read an existing program without pulling tens of
// kilobytes of XML into the context: the DSL is roughly five times more
// compact. Blocks with no DSL equivalent are returned raw — they must not be
// lost.

import type { XmlNode } from '../xml.js';
import { EXPRESSIONS, INSTRUCTIONS, MATH_FUNCTIONS } from './blocks.js';
import type { DslProgram, DslStmt } from './compile.js';

/** Reverse indices are built once: tag+style → DSL operation name. */
const instructionByKey = new Map<string, string>();
for (const [name, spec] of Object.entries(INSTRUCTIONS))
  instructionByKey.set(`${spec.tag}|${spec.style}`, name);

const expressionByKey = new Map<string, string>();
for (const [name, spec] of Object.entries(EXPRESSIONS)) {
  expressionByKey.set(`${spec.tag}|${spec.style}`, name);
  // Some operations are distinguished by the op attribute rather than style.
  if (spec.fixedAttrs?.['op'] !== undefined)
    expressionByKey.set(`${spec.tag}|op=${spec.fixedAttrs['op']}`, name);
}

function decompileExpr(node: XmlNode): unknown {
  if (node.tag === 'Constant') {
    if (node.attrs['number'] !== undefined) {
      const v = Number(node.attrs['number']);
      return Number.isFinite(v) ? v : node.attrs['number'];
    }
    if (node.attrs['bool'] !== undefined) return node.attrs['bool'] === 'true';
    return node.attrs['text'] ?? '';
  }

  if (node.tag === 'Variable') {
    const name = node.attrs['variableName'] ?? '';
    // The compiler accepts "$name" back as a variable reference.
    return `$${name}`;
  }

  if (node.tag === 'CraftProperty') return ['prop', node.attrs['property'] ?? ''];

  if (node.tag === 'MathFunction') {
    const fn = node.attrs['function'] ?? '';
    if ((MATH_FUNCTIONS as readonly string[]).includes(fn))
      return [fn, ...node.children.map(decompileExpr)];
  }

  const style = node.attrs['style'] ?? '';
  const op = node.attrs['op'];
  const name =
    expressionByKey.get(`${node.tag}|${style}`) ??
    (op !== undefined ? expressionByKey.get(`${node.tag}|op=${op}`) : undefined);

  if (name !== undefined) return [name, ...node.children.map(decompileExpr)];

  // An unknown block is kept as is — otherwise decompiling would lose part of
  // the program, which is worse than less pretty output.
  return {
    raw: node.tag,
    attrs: node.attrs,
    args: node.children.map(decompileExpr),
  };
}

function decompileStmt(node: XmlNode): DslStmt {
  const style = node.attrs['style'] ?? '';
  const name = instructionByKey.get(`${node.tag}|${style}`);

  const bodies = node.children.filter((c) => c.tag === 'Instructions');
  const args = node.children.filter((c) => c.tag !== 'Instructions');

  if (name === undefined)
    return [
      'raw',
      { tag: node.tag, attrs: node.attrs },
      ...args.map(decompileExpr),
      ...bodies.map((b) => b.children.map(decompileStmt)),
    ] as DslStmt;

  const spec = INSTRUCTIONS[name];
  const out: unknown[] = [name];
  for (const attrName of spec?.namedAttrs ?? []) {
    const v = node.attrs[attrName];
    if (v !== undefined) out.push(v);
  }
  out.push(...args.map(decompileExpr));
  for (const b of bodies) out.push(b.children.map(decompileStmt));
  return out as DslStmt;
}

export function decompileProgram(program: XmlNode): DslProgram {
  const variablesNode = program.children.find((c) => c.tag === 'Variables');
  const variables = (variablesNode?.children ?? []).map((v) => {
    const entry: { name: string; value?: number | string | boolean } = {
      name: v.attrs['name'] ?? '',
    };
    if (v.attrs['number'] !== undefined) entry.value = Number(v.attrs['number']);
    else if (v.attrs['bool'] !== undefined) entry.value = v.attrs['bool'] === 'true';
    else if (v.attrs['text'] !== undefined) entry.value = v.attrs['text'];
    return entry;
  });

  // The top level is flat: <Event> opens the stack and the elements following
  // it are its body, until the next event appears.
  const instructions = program.children.find((c) => c.tag === 'Instructions');
  const on: Record<string, DslStmt[]> = {};
  let current: DslStmt[] | undefined;
  const orphans: DslStmt[] = [];

  for (const child of instructions?.children ?? []) {
    if (child.tag === 'Event') {
      const eventName = child.attrs['event'] ?? 'FlightStart';
      // The same event may occur twice — do not overwrite the first one.
      const key = on[eventName] === undefined ? eventName : `${eventName}#${Object.keys(on).length}`;
      current = [];
      on[key] = current;
      continue;
    }
    (current ?? orphans).push(decompileStmt(child));
  }
  if (orphans.length > 0) on['(no event)'] = orphans;

  const result: DslProgram = { name: program.attrs['name'] ?? '', on };
  if (variables.length > 0) result.variables = variables;
  if (program.attrs['requiresMfd'] === 'true') result.requiresMfd = true;
  return result;
}
