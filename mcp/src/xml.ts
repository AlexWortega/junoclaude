// XML-слой поверх fast-xml-parser.
//
// Работаем в режиме preserveOrder: игра различает порядок элементов
// (инструкции Vizzy — это последовательность, а не множество), и любая
// нормализация порядка молча сломала бы программу.
//
// Сериализатор воспроизводит форматирование .NET XmlWriter, которым пишет
// игра: два пробела отступа, самозакрывающийся тег с пробелом перед `/>`.
// Это нужно, чтобы round-trip не порождал шумных диффов при сравнении
// нашего вывода с тем, что игра сохранила сама.

import { XMLParser } from 'fast-xml-parser';

export interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Текстовое содержимое — в форматах игры встречается редко. */
  text?: string;
  /** Содержимое XML-комментария; тег тогда равен COMMENT_TAG. */
  comment?: string;
}

/** Псевдотег для узлов-комментариев. */
export const COMMENT_TAG = '#comment';

const ATTR_KEY = ':@';
const TEXT_KEY = '#text';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  // attributesGroupName намеренно не задаём: вместе с пустым attributeNamePrefix
  // fast-xml-parser заворачивает атрибуты в ':@' дважды. Дефолт даёт ':@'
  // с атрибутами напрямую.
  preserveOrder: true,
  parseAttributeValue: false,
  parseTagValue: false,
  // Не обрезаем: в Vizzy пробел на конце значим. `text="T - "` — часть строки,
  // которую программа выводит на экран, и обрезка её молча испортит.
  trimValues: false,
  // Пустой тег должен остаться узлом, а не превратиться в пустую строку,
  // иначе `<Variables />` потеряется при разборе.
  alwaysCreateTextNode: false,
  // Стоковые сценарии-туториалы содержат пояснительные комментарии; терять их
  // при правке файла было бы невежливо по отношению к их авторам.
  commentPropName: COMMENT_TAG,
});

/** Преобразует форму preserveOrder (массив одноключевых объектов) в XmlNode[]. */
function convert(raw: unknown[]): XmlNode[] {
  const out: XmlNode[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const tag = Object.keys(rec).find((k) => k !== ATTR_KEY);
    if (tag === undefined) continue;
    if (tag === TEXT_KEY) continue; // текст подхватывается родителем

    const attrsRaw = (rec[ATTR_KEY] ?? {}) as Record<string, unknown>;
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(attrsRaw)) attrs[k] = String(v);

    const kids = rec[tag];

    if (tag === COMMENT_TAG) {
      const inner = Array.isArray(kids)
        ? (kids.find((k) => k !== null && typeof k === 'object' && TEXT_KEY in (k as object)) as
            | Record<string, unknown>
            | undefined)
        : undefined;
      out.push({
        tag: COMMENT_TAG,
        attrs: {},
        children: [],
        comment: String(inner?.[TEXT_KEY] ?? ''),
      });
      continue;
    }

    const node: XmlNode = { tag, attrs, children: [] };
    if (Array.isArray(kids)) {
      node.children = convert(kids);
      const textNode = kids.find(
        (k) => k !== null && typeof k === 'object' && TEXT_KEY in (k as object)
      ) as Record<string, unknown> | undefined;
      if (textNode !== undefined) {
        const t = String(textNode[TEXT_KEY] ?? '');
        if (t !== '') node.text = t;
      }
    }
    out.push(node);
  }
  return out;
}

/**
 * Как именно отформатирован файл. Игра пишет CRLF + BOM + два пробела, но
 * шаблонные файлы в поставке отформатированы иначе (например `__new__.xml`
 * использует три пробела, а `MFD Stats.xml` идёт без BOM). Запоминаем профиль
 * при разборе и воспроизводим при записи, чтобы правка одного атрибута не
 * приводила к переформатированию всего файла.
 */
export interface XmlFormat {
  bom: boolean;
  eol: string;
  indent: string;
  declaration: boolean;
  /** Файл заканчивается переводом строки. */
  trailingNewline: boolean;
}

export function detectFormat(text: string): XmlFormat {
  const bom = text.charCodeAt(0) === 0xfeff;
  const body = bom ? text.slice(1) : text;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = body.split(eol);
  // Первая строка с ведущими пробелами задаёт шаг отступа.
  const indented = lines.find((l) => /^\s+\S/.test(l));
  const indent = indented ? (/^\s+/.exec(indented)?.[0] ?? '  ') : '  ';
  return {
    bom,
    eol,
    indent,
    declaration: body.startsWith('<?xml'),
    trailingNewline: body.endsWith(eol),
  };
}

/** Разбирает документ, отбрасывая BOM и XML-декларацию (их восстановит сериализатор). */
export function parseXml(text: string): XmlNode[] {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return convert(parser.parse(clean) as unknown[]).filter((n) => n.tag !== '?xml');
}

/** Разбирает документ и возвращает единственный корневой элемент. */
export function parseXmlRoot(text: string, expectedTag?: string): XmlNode {
  const nodes = parseXml(text);
  const root = nodes[0];
  if (root === undefined) throw new Error('XML не содержит корневого элемента');
  if (expectedTag !== undefined && root.tag !== expectedTag)
    throw new Error(`Ожидался корневой элемент <${expectedTag}>, получен <${root.tag}>`);
  return root;
}

/** Разбор вместе с профилем форматирования — для правок, сохраняющих файл как был. */
export function parseXmlDocument(
  text: string,
  expectedTag?: string
): { root: XmlNode; format: XmlFormat } {
  return { root: parseXmlRoot(text, expectedTag), format: detectFormat(text) };
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

/**
 * Экранирует значение атрибута так же, как .NET XmlWriter: одинарная кавычка
 * не трогается (атрибуты пишутся в двойных), перевод строки — числовой ссылкой.
 */
function escapeAttr(value: string): string {
  return value
    .replace(/[&<>"]/g, (c) => ESCAPES[c] as string)
    .replace(/\n/g, '&#xA;')
    .replace(/\r/g, '&#xD;')
    .replace(/\t/g, '&#x9;');
}

function escapeText(value: string): string {
  return value.replace(/[&<>]/g, (c) => ESCAPES[c] as string);
}

function writeNode(node: XmlNode, indent: string, step: string, out: string[]): void {
  if (node.tag === COMMENT_TAG) {
    out.push(`${indent}<!--${node.comment ?? ''}-->`);
    return;
  }

  const attrs = Object.entries(node.attrs)
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
    .join('');

  const hasChildren = node.children.length > 0;
  const hasText = node.text !== undefined && node.text !== '';

  if (!hasChildren && !hasText) {
    out.push(`${indent}<${node.tag}${attrs} />`);
    return;
  }
  if (!hasChildren && hasText) {
    out.push(`${indent}<${node.tag}${attrs}>${escapeText(node.text as string)}</${node.tag}>`);
    return;
  }
  out.push(`${indent}<${node.tag}${attrs}>`);
  for (const child of node.children) writeNode(child, indent + step, step, out);
  out.push(`${indent}</${node.tag}>`);
}

/** Профиль по умолчанию — так пишет сама игра. */
export const GAME_FORMAT: XmlFormat = {
  bom: true,
  eol: '\r\n',
  indent: '  ',
  declaration: true,
  trailingNewline: false,
};

/**
 * Сериализует дерево. При передаче профиля, полученного из `parseXmlDocument`,
 * разбор и обратная сборка стоковых файлов дают побайтово исходный текст —
 * это и есть проверка, что мы ничего не потеряли.
 */
export function buildXml(root: XmlNode, format: Partial<XmlFormat> = {}): string {
  const f = { ...GAME_FORMAT, ...format };
  const out: string[] = [];
  if (f.declaration) out.push('<?xml version="1.0" encoding="utf-8"?>');
  writeNode(root, '', f.indent, out);
  return (f.bom ? '﻿' : '') + out.join(f.eol) + (f.trailingNewline ? f.eol : '');
}

// --- Мелкие помощники обхода ---

export const childrenNamed = (node: XmlNode, tag: string): XmlNode[] =>
  node.children.filter((c) => c.tag === tag);

export const childNamed = (node: XmlNode, tag: string): XmlNode | undefined =>
  node.children.find((c) => c.tag === tag);

/** Число из атрибута; undefined, если атрибута нет или он не число. */
export function attrNum(node: XmlNode, name: string): number | undefined {
  const raw = node.attrs[name];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Вектор вида "1,2,3" → [1,2,3]. */
export function attrVec(node: XmlNode, name: string): number[] | undefined {
  const raw = node.attrs[name];
  if (raw === undefined) return undefined;
  const parts = raw.split(',').map(Number);
  return parts.every(Number.isFinite) ? parts : undefined;
}
