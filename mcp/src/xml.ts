// The XML layer on top of fast-xml-parser.
//
// We work in preserveOrder mode: the game distinguishes element order (Vizzy
// instructions are a sequence, not a set), and any normalisation of that order
// would silently break the program.
//
// The serialiser reproduces the .NET XmlWriter formatting the game writes with:
// two-space indent, a self-closing tag with a space before `/>`. This is needed
// so a round-trip does not produce noisy diffs when comparing our output with
// what the game saved itself.

import { XMLParser } from 'fast-xml-parser';

export interface XmlNode {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  /** Text content — rare in the game's formats. */
  text?: string;
  /** The contents of an XML comment; the tag is then COMMENT_TAG. */
  comment?: string;
}

/** Pseudo-tag for comment nodes. */
export const COMMENT_TAG = '#comment';

const ATTR_KEY = ':@';
const TEXT_KEY = '#text';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  // attributesGroupName is deliberately left unset: together with an empty
  // attributeNamePrefix, fast-xml-parser wraps attributes in ':@' twice. The
  // default gives ':@' with the attributes directly.
  preserveOrder: true,
  parseAttributeValue: false,
  parseTagValue: false,
  // Do not trim: in Vizzy a trailing space is significant. `text="T - "` is
  // part of the string the program prints on screen, and trimming silently
  // corrupts it.
  trimValues: false,
  // An empty tag must stay a node rather than turn into an empty string,
  // otherwise `<Variables />` is lost on parse.
  alwaysCreateTextNode: false,
  // The stock tutorial scenarios contain explanatory comments; losing them
  // when editing a file would be discourteous to their authors.
  commentPropName: COMMENT_TAG,
});

/** Converts the preserveOrder form (an array of single-key objects) into XmlNode[]. */
function convert(raw: unknown[]): XmlNode[] {
  const out: XmlNode[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const tag = Object.keys(rec).find((k) => k !== ATTR_KEY);
    if (tag === undefined) continue;
    if (tag === TEXT_KEY) continue; // text is picked up by the parent

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
 * How exactly a file is formatted. The game writes CRLF + BOM + two spaces, but
 * the template files it ships are formatted differently (for example
 * `__new__.xml` uses three spaces, and `MFD Stats.xml` comes without a BOM). We
 * record the profile on parse and replay it on write, so that editing a single
 * attribute does not reformat the whole file.
 */
export interface XmlFormat {
  bom: boolean;
  eol: string;
  indent: string;
  declaration: boolean;
  /** The file ends with a newline. */
  trailingNewline: boolean;
}

export function detectFormat(text: string): XmlFormat {
  const bom = text.charCodeAt(0) === 0xfeff;
  const body = bom ? text.slice(1) : text;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = body.split(eol);
  // The first line with leading whitespace defines the indent step.
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

/** Parses a document, dropping the BOM and XML declaration (the serialiser restores them). */
export function parseXml(text: string): XmlNode[] {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return convert(parser.parse(clean) as unknown[]).filter((n) => n.tag !== '?xml');
}

/** Parses a document and returns its single root element. */
export function parseXmlRoot(text: string, expectedTag?: string): XmlNode {
  const nodes = parseXml(text);
  const root = nodes[0];
  if (root === undefined) throw new Error('The XML has no root element');
  if (expectedTag !== undefined && root.tag !== expectedTag)
    throw new Error(`Expected root element <${expectedTag}>, got <${root.tag}>`);
  return root;
}

/** Parse together with the format profile — for edits that keep the file as it was. */
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
 * Escapes an attribute value the way .NET XmlWriter does: a single quote is
 * left alone (attributes are written in double quotes), a newline becomes a
 * numeric reference.
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

/** The default profile — this is how the game itself writes. */
export const GAME_FORMAT: XmlFormat = {
  bom: true,
  eol: '\r\n',
  indent: '  ',
  declaration: true,
  trailingNewline: false,
};

/**
 * Serialises the tree. Given a profile obtained from `parseXmlDocument`,
 * parsing and rebuilding a stock file reproduces the original text byte for
 * byte — which is exactly the check that we lost nothing.
 */
export function buildXml(root: XmlNode, format: Partial<XmlFormat> = {}): string {
  const f = { ...GAME_FORMAT, ...format };
  const out: string[] = [];
  if (f.declaration) out.push('<?xml version="1.0" encoding="utf-8"?>');
  writeNode(root, '', f.indent, out);
  return (f.bom ? '﻿' : '') + out.join(f.eol) + (f.trailingNewline ? f.eol : '');
}

// --- Small traversal helpers ---

export const childrenNamed = (node: XmlNode, tag: string): XmlNode[] =>
  node.children.filter((c) => c.tag === tag);

export const childNamed = (node: XmlNode, tag: string): XmlNode | undefined =>
  node.children.find((c) => c.tag === tag);

/** A number from an attribute; undefined if the attribute is absent or not a number. */
export function attrNum(node: XmlNode, name: string): number | undefined {
  const raw = node.attrs[name];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** A vector of the form "1,2,3" → [1,2,3]. */
export function attrVec(node: XmlNode, name: string): number[] | undefined {
  const raw = node.attrs[name];
  if (raw === undefined) return undefined;
  const parts = raw.split(',').map(Number);
  return parts.every(Number.isFinite) ? parts : undefined;
}
