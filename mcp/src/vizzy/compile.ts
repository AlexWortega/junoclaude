// Компилятор DSL → Vizzy XML.
//
// Правила, установленные разбором стоковых программ и критичные для того,
// чтобы игра приняла результат:
//   * id получают только инструкции; у выражений (<Constant>, <BinaryOp>…) их нет
//   * id идут в порядке обхода документа, начиная с события
//   * верхний уровень <Instructions> — плоский список: <Event> открывает стек,
//     следующие за ним элементы и есть его тело, а не вложенные дети
//   * pos нужен верхнеуровневым блокам; игра расставляет его сама, но без него
//     блоки в редакторе лягут друг на друга

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

/** Выражение DSL: литерал, "$переменная", или ["оператор", аргументы…]. */
export type DslExpr = number | string | boolean | DslExpr[];

/** Инструкция DSL: ["операция", аргументы…], тело — вложенным массивом. */
export type DslStmt = [string, ...unknown[]];

export interface DslProgram {
  name: string;
  variables?: Array<{ name: string; value?: number | string | boolean; list?: boolean }>;
  /** Событие → последовательность инструкций. */
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

/** Числа Vizzy пишет без экспоненциальной записи. */
function numText(v: number): string {
  if (!Number.isFinite(v)) throw new Error(`Нечисловое значение: ${v}`);
  return Number.isInteger(v) ? String(v) : String(v);
}

class Compiler {
  private nextId = 0;
  private topY = -20;
  private readonly TOP_SPACING = 60;

  constructor(private readonly craftProperties: Set<string>) {}

  /** Выражения не нумеруются — это правило проверено на стоковых программах. */
  private expr(e: DslExpr, path: string): XmlNode {
    if (typeof e === 'number') return node('Constant', { number: numText(e) });
    if (typeof e === 'boolean') return node('Constant', { bool: String(e) });

    if (typeof e === 'string') {
      // "$имя" — сахар для ссылки на переменную; всё прочее — текстовый литерал.
      if (e.startsWith('$'))
        return node('Variable', { list: 'false', local: 'true', variableName: e.slice(1) });
      return node('Constant', { text: e });
    }

    if (!Array.isArray(e) || e.length === 0)
      throw new CompileError(`Пустое выражение`, path);

    const [op, ...args] = e as [string, ...DslExpr[]];
    if (typeof op !== 'string')
      throw new CompileError(`Оператор выражения должен быть строкой`, path);

    if (op === 'var') {
      const name = args[0];
      if (typeof name !== 'string')
        throw new CompileError(`var требует имя переменной`, path);
      return node('Variable', { list: 'false', local: 'true', variableName: name });
    }

    if (op === 'prop') {
      const property = args[0];
      if (typeof property !== 'string')
        throw new CompileError(`prop требует имя свойства`, path);
      if (!this.craftProperties.has(property)) {
        const near = suggest(property, [...this.craftProperties]);
        throw new CompileError(
          `Неизвестное свойство крафта «${property}»`,
          path,
          near.length > 0
            ? `Возможно: ${near.join(', ')}`
            : `Список свойств — в справочнике vizzy-blocks.`
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
        `Неизвестная операция «${op}»`,
        path,
        near.length > 0 ? `Возможно: ${near.join(', ')}` : undefined
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
        `«${op}» ожидает ${spec.args.length} аргумент(ов), получено ${args.length}`,
        path,
        `Аргументы: ${spec.args.map((a) => a.name).join(', ')}`
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
    // Стиль выводится из группы свойства: Altitude.ASL → prop-altitude.
    const group = property.split('.')[0] ?? '';
    return `prop-${group.toLowerCase()}`;
  }

  private stmt(s: DslStmt, path: string, top: boolean): XmlNode {
    if (!Array.isArray(s) || s.length === 0)
      throw new CompileError(`Пустая инструкция`, path);
    const [op, ...rest] = s;
    if (typeof op !== 'string')
      throw new CompileError(`Имя инструкции должно быть строкой`, path);

    const spec = INSTRUCTIONS[op];
    if (spec === undefined) {
      const near = suggest(op, Object.keys(INSTRUCTIONS));
      throw new CompileError(
        `Неизвестная инструкция «${op}»`,
        path,
        near.length > 0 ? `Возможно: ${near.join(', ')}` : undefined
      );
    }

    const attrs: Record<string, string> = { ...spec.fixedAttrs };

    // Именованные атрибуты (input у set-input, var у for) приходят первыми
    // позиционными аргументами — так вызов читается как обычный код.
    const named = spec.namedAttrs ?? [];
    const positional = [...rest];
    for (const attrName of named) {
      const value = positional.shift();
      if (typeof value !== 'string' && typeof value !== 'number')
        throw new CompileError(
          `«${op}» требует ${attrName} первым аргументом`,
          path,
          `Например: ["${op}", "${attrName === 'input' ? 'throttle' : 'имя'}", …]`
        );
      attrs[attrName] = String(value);
    }

    let body: DslStmt[] | undefined;
    let elseBody: DslStmt[] | undefined;
    if (spec.elseBody === true) elseBody = positional.pop() as DslStmt[] | undefined;
    if (spec.body === true) {
      const last = positional.pop();
      if (!Array.isArray(last))
        throw new CompileError(`«${op}» требует тело последним аргументом (массив инструкций)`, path);
      body = last as DslStmt[];
    }

    if (positional.length !== spec.args.length)
      throw new CompileError(
        `«${op}» ожидает ${spec.args.length} аргумент(ов) до тела, получено ${positional.length}`,
        path,
        `Аргументы: ${spec.args.map((a) => a.name).join(', ')}`
      );

    attrs['id'] = String(this.nextId++);
    attrs['style'] = spec.style;
    if (top) {
      attrs['pos'] = `-10,${this.topY}`;
      this.topY -= this.TOP_SPACING;
    }

    const children = positional.map((a, i) => this.expr(a as DslExpr, `${path}.${op}[${i}]`));

    // Текст комментария игра держит в константе особого вида: она несменяема
    // и рисуется иначе. Без этих атрибутов редактор покажет обычное поле ввода.
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
        `Программа не содержит ни одного обработчика события`,
        'on',
        `Добавьте хотя бы { "on": { "FlightStart": [...] } }`
      );

    for (const [eventName, body] of events) {
      const style = EVENTS[eventName];
      if (style === undefined) {
        const near = suggest(eventName, Object.keys(EVENTS));
        throw new CompileError(
          `Неизвестное событие «${eventName}»`,
          `on.${eventName}`,
          `Доступны: ${Object.keys(EVENTS).join(', ')}${near.length > 0 ? `. Возможно: ${near[0]}` : ''}`
        );
      }
      // Событие и его тело лежат плоско, друг за другом: <Event/> открывает
      // стек, а следующие элементы — его продолжение.
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
