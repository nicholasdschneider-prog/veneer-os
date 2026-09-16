import JSZip, { type JSZipObject } from 'jszip';
import { XMLParser } from 'fast-xml-parser';

export type OfficeFileKind = 'docx' | 'xlsx';

export interface DocxRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  href?: string;
  break?: 'line' | 'page';
  image?: boolean;
}

export interface DocxParagraph {
  kind: 'paragraph';
  style: 'normal' | 'title' | 'heading1' | 'heading2' | 'heading3' | 'heading4' | 'heading5' | 'heading6';
  runs: DocxRun[];
  list?: { level: number; ordered: boolean };
}

export interface DocxTable {
  kind: 'table';
  rows: { cells: { blocks: DocxBlock[] }[]; header: boolean }[];
}

export interface DocxPageBreak {
  kind: 'pageBreak';
}

export type DocxBlock = DocxParagraph | DocxTable | DocxPageBreak;

export interface DocxPreview {
  kind: 'docx';
  blocks: DocxBlock[];
  truncated: boolean;
}

export interface XlsxCell {
  display: string;
  type: 'blank' | 'text' | 'number' | 'date' | 'boolean' | 'formula' | 'error';
}

export interface XlsxRow {
  index: number;
  cells: XlsxCell[];
}

export interface XlsxSheet {
  name: string;
  state: 'visible' | 'hidden' | 'veryHidden';
  rows: XlsxRow[];
  truncated: boolean;
}

export interface XlsxPreview {
  kind: 'xlsx';
  sheets: XlsxSheet[];
  truncated: boolean;
}

export type OfficePreview = DocxPreview | XlsxPreview;

export const OFFICE_MAX_PACKAGE_BYTES = 25 * 1024 * 1024;
const OFFICE_MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const OFFICE_MAX_TOTAL_BYTES = 60 * 1024 * 1024;
const OFFICE_MAX_ENTRIES = 5_000;
const DOCX_MAX_BLOCKS = 1_500;
const DOCX_MAX_TABLE_ROWS = 250;
const DOCX_MAX_TABLE_COLUMNS = 50;
const XLSX_MAX_SHEETS = 50;
const XLSX_MAX_ROWS_PER_SHEET = 200;
const XLSX_MAX_COLUMNS = 100;
const XLSX_MAX_CELLS_PER_SHEET = 20_000;
const CELL_TEXT_LIMIT = 2_000;

type OrderedNode = Record<string, unknown>;

interface ElementNode {
  name: string;
  attrs: Record<string, unknown>;
  children: OrderedNode[];
}

interface SizedZipObject extends JSZipObject {
  _data?: { uncompressedSize?: number };
  unsafeOriginalName?: string;
}

const XML_PARSER = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
  trimValues: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

const ACTIVE_CONTENT_RE = /(?:^|\/)(?:vbaProject\.bin|activeX\/|embeddings\/|customUI\/|EncryptedPackage$)/i;
const XML_DECLARATION_RE = /<!\s*(?:DOCTYPE|ENTITY)\b/i;
const SAFE_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53,
  54, 55, 56, 57, 58,
]);

export function officeFileKind(name: string): OfficeFileKind | null {
  const lower = name.toLowerCase();
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.xlsx')) return 'xlsx';
  return null;
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function cleanText(value: string): string {
  return decodeXmlText(value)
    .replace(/_x([0-9a-f]{4})_/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '�');
}

function localName(name: string): string {
  return name.slice(name.lastIndexOf(':') + 1);
}

function asNodes(value: unknown): OrderedNode[] {
  return Array.isArray(value) ? (value as OrderedNode[]) : [];
}

function elementOf(node: OrderedNode): ElementNode | null {
  for (const [name, value] of Object.entries(node)) {
    if (name === ':@' || name.startsWith('#')) continue;
    return {
      name: localName(name),
      attrs: (node[':@'] as Record<string, unknown> | undefined) ?? {},
      children: asNodes(value),
    };
  }
  return null;
}

function childElements(nodes: OrderedNode[], name?: string): ElementNode[] {
  const output: ElementNode[] = [];
  for (const node of nodes) {
    const element = elementOf(node);
    if (element && (!name || element.name === name)) output.push(element);
  }
  return output;
}

function firstChild(nodes: OrderedNode[], name: string): ElementNode | undefined {
  return childElements(nodes, name)[0];
}

function descendants(nodes: OrderedNode[], name: string): ElementNode[] {
  const output: ElementNode[] = [];
  for (const element of childElements(nodes)) {
    if (element.name === name) output.push(element);
    output.push(...descendants(element.children, name));
  }
  return output;
}

function attr(element: ElementNode | undefined, name: string): string | undefined {
  if (!element) return undefined;
  for (const [key, value] of Object.entries(element.attrs)) {
    if (localName(key) === name && value !== undefined) return cleanText(String(value));
  }
  return undefined;
}

function textContent(nodes: OrderedNode[]): string {
  let output = '';
  for (const node of nodes) {
    const text = node['#text'];
    if (typeof text === 'string' || typeof text === 'number') output += cleanText(String(text));
    const cdata = node['#cdata'];
    if (typeof cdata === 'string' || typeof cdata === 'number') output += cleanText(String(cdata));
    const element = elementOf(node);
    if (element) output += textContent(element.children);
  }
  return output;
}

function parseXml(xml: string, label: string): OrderedNode[] {
  if (XML_DECLARATION_RE.test(xml)) throw new Error(`${label} contains unsupported XML declarations.`);
  try {
    const parsed = XML_PARSER.parse(xml) as unknown;
    if (!Array.isArray(parsed)) throw new Error('The XML root is missing.');
    return parsed as OrderedNode[];
  } catch (error) {
    throw new Error(`${label} is not valid XML: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function entrySize(entry: JSZipObject): number | undefined {
  return (entry as SizedZipObject)._data?.uncompressedSize;
}

async function loadOfficeZip(input: ArrayBuffer | Uint8Array, kind: OfficeFileKind): Promise<JSZip> {
  const size = input.byteLength;
  if (size > OFFICE_MAX_PACKAGE_BYTES) {
    throw new Error('This file is too large to preview safely. Download it to view the full file.');
  }
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error(`This is not a valid ${kind.toUpperCase()} file.`);

  let zip: JSZip;
  try {
    // Do not ask JSZip to check every CRC here. That option expands every ZIP
    // entry before we can inspect the central-directory sizes, which defeats
    // the ZIP-bomb guard. Required XML entries are expanded only after the
    // entry and package limits below pass.
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new Error(`This ${kind.toUpperCase()} file is damaged or is not a valid OOXML ZIP file.`);
  }

  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length > OFFICE_MAX_ENTRIES) throw new Error('This file has too many ZIP entries to preview safely.');
  let total = 0;
  for (const entry of entries) {
    const sized = entry as SizedZipObject;
    if (sized.unsafeOriginalName && sized.unsafeOriginalName !== entry.name) {
      throw new Error('This file contains an unsafe ZIP path.');
    }
    if (ACTIVE_CONTENT_RE.test(entry.name)) {
      throw new Error('This file contains macros or embedded active content. Download it only if you trust its source.');
    }
    const uncompressed = entrySize(entry);
    if (uncompressed !== undefined) {
      if (uncompressed > OFFICE_MAX_ENTRY_BYTES) throw new Error('This file contains an entry that is too large to preview safely.');
      total += uncompressed;
      if (total > OFFICE_MAX_TOTAL_BYTES) throw new Error('This file expands beyond the safe preview limit.');
    }
  }

  const required =
    kind === 'docx'
      ? ['[Content_Types].xml', 'word/document.xml']
      : ['[Content_Types].xml', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels'];
  for (const name of required) {
    if (!zip.file(name)) throw new Error(`This ${kind.toUpperCase()} file is missing ${name}.`);
  }
  return zip;
}

async function readXml(zip: JSZip, name: string, required = true): Promise<string | null> {
  const entry = zip.file(name);
  if (!entry) {
    if (!required) return null;
    throw new Error(`This file is missing ${name}.`);
  }
  const size = entrySize(entry);
  if (size !== undefined && size > OFFICE_MAX_ENTRY_BYTES) throw new Error(`${name} is too large to preview safely.`);
  const value = await entry.async('string');
  if (value.length > OFFICE_MAX_ENTRY_BYTES) throw new Error(`${name} is too large to preview safely.`);
  return value;
}

function safeHref(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith('#') && /^#[A-Za-z0-9_.:-]+$/.test(value)) return value;
  try {
    const url = new URL(value);
    return SAFE_LINK_PROTOCOLS.has(url.protocol) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

async function docxRelationships(zip: JSZip): Promise<Map<string, string>> {
  const xml = await readXml(zip, 'word/_rels/document.xml.rels', false);
  const output = new Map<string, string>();
  if (!xml) return output;
  const root = firstChild(parseXml(xml, 'DOCX relationships'), 'Relationships');
  for (const relationship of childElements(root?.children ?? [], 'Relationship')) {
    const id = attr(relationship, 'Id');
    const target = attr(relationship, 'Target');
    const mode = attr(relationship, 'TargetMode');
    if (id && target && mode === 'External') {
      const href = safeHref(target);
      if (href) output.set(id, href);
    }
  }
  return output;
}

async function docxNumbering(zip: JSZip): Promise<Map<string, Map<number, boolean>>> {
  const xml = await readXml(zip, 'word/numbering.xml', false);
  const output = new Map<string, Map<number, boolean>>();
  if (!xml) return output;
  const root = firstChild(parseXml(xml, 'DOCX numbering'), 'numbering');
  const abstract = new Map<string, Map<number, boolean>>();
  for (const definition of childElements(root?.children ?? [], 'abstractNum')) {
    const id = attr(definition, 'abstractNumId');
    if (!id) continue;
    const levels = new Map<number, boolean>();
    for (const level of childElements(definition.children, 'lvl')) {
      const index = Number(attr(level, 'ilvl') ?? 0);
      const format = attr(firstChild(level.children, 'numFmt'), 'val') ?? 'bullet';
      if (Number.isInteger(index)) levels.set(index, format !== 'bullet' && format !== 'none');
    }
    abstract.set(id, levels);
  }
  for (const instance of childElements(root?.children ?? [], 'num')) {
    const id = attr(instance, 'numId');
    const abstractId = attr(firstChild(instance.children, 'abstractNumId'), 'val');
    if (id && abstractId && abstract.has(abstractId)) output.set(id, abstract.get(abstractId)!);
  }
  return output;
}

function onOff(element: ElementNode | undefined): boolean {
  if (!element) return false;
  const value = (attr(element, 'val') ?? 'true').toLowerCase();
  return !['0', 'false', 'off', 'none'].includes(value);
}

function parseDocxRun(run: ElementNode, href?: string): DocxRun[] {
  const properties = firstChild(run.children, 'rPr');
  const fonts = firstChild(properties?.children ?? [], 'rFonts');
  const runStyle = attr(firstChild(properties?.children ?? [], 'rStyle'), 'val') ?? '';
  const font = `${attr(fonts, 'ascii') ?? ''} ${attr(fonts, 'hAnsi') ?? ''}`;
  const style = {
    bold: onOff(firstChild(properties?.children ?? [], 'b')),
    italic: onOff(firstChild(properties?.children ?? [], 'i')),
    strike: onOff(firstChild(properties?.children ?? [], 'strike')) || onOff(firstChild(properties?.children ?? [], 'dstrike')),
    code: /mono|courier|consolas/i.test(font) || /code|verbatim/i.test(runStyle),
    href,
  };
  const output: DocxRun[] = [];
  for (const child of childElements(run.children)) {
    if (child.name === 't' || child.name === 'delText') {
      const text = textContent(child.children);
      if (text) output.push({ text, ...style });
    } else if (child.name === 'tab') {
      output.push({ text: '\t', ...style });
    } else if (child.name === 'br' || child.name === 'cr') {
      output.push({ text: '', ...style, break: attr(child, 'type') === 'page' ? 'page' : 'line' });
    } else if (child.name === 'lastRenderedPageBreak') {
      output.push({ text: '', ...style, break: 'page' });
    } else if (['drawing', 'pict'].includes(child.name)) {
      const description = attr(descendants(child.children, 'docPr')[0], 'descr') ?? attr(descendants(child.children, 'docPr')[0], 'name');
      output.push({ text: description ? `Image: ${description}` : 'Image', ...style, image: true });
    }
  }
  return output;
}

function docxParagraphStyle(properties: ElementNode | undefined): DocxParagraph['style'] {
  const value = (attr(firstChild(properties?.children ?? [], 'pStyle'), 'val') ?? '').toLowerCase();
  if (value === 'title') return 'title';
  const heading = value.match(/heading\s*([1-6])/);
  return heading ? (`heading${heading[1]}` as DocxParagraph['style']) : 'normal';
}

function parseDocxParagraph(
  paragraph: ElementNode,
  relationships: Map<string, string>,
  numbering: Map<string, Map<number, boolean>>,
): DocxParagraph | DocxPageBreak {
  const properties = firstChild(paragraph.children, 'pPr');
  const runs: DocxRun[] = [];
  for (const child of childElements(paragraph.children)) {
    if (child.name === 'r') {
      runs.push(...parseDocxRun(child));
    } else if (child.name === 'hyperlink') {
      const relationshipId = attr(child, 'id');
      const anchor = attr(child, 'anchor');
      const href = relationshipId ? relationships.get(relationshipId) : safeHref(anchor ? `#${anchor}` : undefined);
      for (const nested of childElements(child.children, 'r')) runs.push(...parseDocxRun(nested, href));
    } else if (['smartTag', 'sdt', 'ins'].includes(child.name)) {
      for (const nested of descendants(child.children, 'r')) runs.push(...parseDocxRun(nested));
    }
  }
  if (runs.length > 0 && runs.every((run) => run.break === 'page' || !run.text) && runs.some((run) => run.break === 'page')) {
    return { kind: 'pageBreak' };
  }
  const numPr = firstChild(properties?.children ?? [], 'numPr');
  const numId = attr(firstChild(numPr?.children ?? [], 'numId'), 'val');
  const level = Math.max(0, Math.min(8, Number(attr(firstChild(numPr?.children ?? [], 'ilvl'), 'val') ?? 0) || 0));
  const list = numId ? { level, ordered: numbering.get(numId)?.get(level) ?? false } : undefined;
  return { kind: 'paragraph', style: docxParagraphStyle(properties), runs, list };
}

function parseDocxBlocks(
  nodes: OrderedNode[],
  relationships: Map<string, string>,
  numbering: Map<string, Map<number, boolean>>,
  budget: { count: number; truncated: boolean },
): DocxBlock[] {
  const blocks: DocxBlock[] = [];
  for (const child of childElements(nodes)) {
    if (budget.count >= DOCX_MAX_BLOCKS) {
      budget.truncated = true;
      break;
    }
    if (child.name === 'p') {
      blocks.push(parseDocxParagraph(child, relationships, numbering));
      budget.count += 1;
    } else if (child.name === 'tbl') {
      const rows: DocxTable['rows'] = [];
      const tableRows = childElements(child.children, 'tr');
      if (tableRows.length > DOCX_MAX_TABLE_ROWS) budget.truncated = true;
      for (const [rowIndex, row] of tableRows.slice(0, DOCX_MAX_TABLE_ROWS).entries()) {
        const cells = childElements(row.children, 'tc');
        if (cells.length > DOCX_MAX_TABLE_COLUMNS) budget.truncated = true;
        rows.push({
          header: rowIndex === 0 || Boolean(firstChild(firstChild(row.children, 'trPr')?.children ?? [], 'tblHeader')),
          cells: cells.slice(0, DOCX_MAX_TABLE_COLUMNS).map((cell) => ({
            blocks: parseDocxBlocks(cell.children, relationships, numbering, budget),
          })),
        });
      }
      blocks.push({ kind: 'table', rows });
      budget.count += 1;
    }
  }
  return blocks;
}

async function parseDocx(zip: JSZip): Promise<DocxPreview> {
  const [documentXml, relationships, numbering] = await Promise.all([
    readXml(zip, 'word/document.xml'),
    docxRelationships(zip),
    docxNumbering(zip),
  ]);
  const root = firstChild(parseXml(documentXml!, 'DOCX document'), 'document');
  const body = firstChild(root?.children ?? [], 'body');
  if (!body) throw new Error('This DOCX file does not contain a document body.');
  const budget = { count: 0, truncated: false };
  return { kind: 'docx', blocks: parseDocxBlocks(body.children, relationships, numbering, budget), truncated: budget.truncated };
}

function resolvePackagePath(base: string, target: string): string | null {
  if (!target || target.startsWith('/') || target.includes('\\') || /^[a-z]+:/i.test(target)) return null;
  const parts = base.split('/');
  parts.pop();
  for (const part of target.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

async function workbookRelationships(zip: JSZip): Promise<Map<string, string>> {
  const xml = await readXml(zip, 'xl/_rels/workbook.xml.rels');
  const root = firstChild(parseXml(xml!, 'XLSX relationships'), 'Relationships');
  const output = new Map<string, string>();
  for (const relationship of childElements(root?.children ?? [], 'Relationship')) {
    if (attr(relationship, 'TargetMode') === 'External') continue;
    const id = attr(relationship, 'Id');
    const target = resolvePackagePath('xl/workbook.xml', attr(relationship, 'Target') ?? '');
    if (id && target?.startsWith('xl/')) output.set(id, target);
  }
  return output;
}

async function sharedStrings(zip: JSZip): Promise<string[]> {
  const xml = await readXml(zip, 'xl/sharedStrings.xml', false);
  if (!xml) return [];
  const root = firstChild(parseXml(xml, 'XLSX shared strings'), 'sst');
  return childElements(root?.children ?? [], 'si').map((item) => descendants(item.children, 't').map((text) => textContent(text.children)).join(''));
}

interface WorkbookStyles {
  dateStyles: Set<number>;
  formats: Map<number, string>;
}

function looksLikeDateFormat(format: string): boolean {
  const cleaned = format.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '');
  return /(^|[^a-z])[ymdhis]+([^a-z]|$)/i.test(cleaned);
}

async function workbookStyles(zip: JSZip): Promise<WorkbookStyles> {
  const xml = await readXml(zip, 'xl/styles.xml', false);
  const output: WorkbookStyles = { dateStyles: new Set(), formats: new Map() };
  if (!xml) return output;
  const root = firstChild(parseXml(xml, 'XLSX styles'), 'styleSheet');
  const customFormats = new Map<number, string>();
  const numFmts = firstChild(root?.children ?? [], 'numFmts');
  for (const format of childElements(numFmts?.children ?? [], 'numFmt')) {
    const id = Number(attr(format, 'numFmtId'));
    const code = attr(format, 'formatCode');
    if (Number.isInteger(id) && code) customFormats.set(id, code);
  }
  const cellXfs = firstChild(root?.children ?? [], 'cellXfs');
  for (const [styleIndex, xf] of childElements(cellXfs?.children ?? [], 'xf').entries()) {
    const formatId = Number(attr(xf, 'numFmtId') ?? 0);
    const format = customFormats.get(formatId) ?? '';
    output.formats.set(styleIndex, format);
    if (BUILTIN_DATE_FORMATS.has(formatId) || looksLikeDateFormat(format)) output.dateStyles.add(styleIndex);
  }
  return output;
}

function columnIndex(reference: string): number | null {
  const match = reference.match(/^([A-Z]{1,3})[1-9][0-9]*$/i);
  if (!match) return null;
  let value = 0;
  for (const character of match[1]!.toUpperCase()) value = value * 26 + character.charCodeAt(0) - 64;
  return value - 1;
}

function rowIndex(reference: string): number | null {
  const match = reference.match(/^[A-Z]{1,3}([1-9][0-9]*)$/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

function excelDate(serial: number, date1904: boolean, withTime: boolean): string | null {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465) return null;
  const wholeDays = Math.floor(serial);
  const fraction = serial - wholeDays;
  if (!date1904 && wholeDays === 60) {
    if (!withTime && fraction === 0) return '1900-02-29';
    const time = new Date(Math.round(fraction * 86_400_000)).toISOString().slice(11, 16);
    return `1900-02-29 ${time}`;
  }
  let milliseconds: number;
  if (date1904) {
    milliseconds = Date.UTC(1904, 0, 1) + wholeDays * 86_400_000;
  } else {
    const adjusted = wholeDays > 0 && wholeDays < 60 ? wholeDays + 1 : wholeDays;
    milliseconds = Date.UTC(1899, 11, 30) + adjusted * 86_400_000;
  }
  milliseconds += Math.round(fraction * 86_400_000);
  const iso = new Date(milliseconds).toISOString();
  return withTime || fraction !== 0 ? iso.slice(0, 16).replace('T', ' ') : iso.slice(0, 10);
}

function numberDisplay(value: string, format: string): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  const decimals = Math.min(12, Math.max(0, (format.split('.')[1]?.match(/[0#]+/)?.[0].length ?? 0)));
  if (format.includes('%')) return `${(number * 100).toFixed(decimals)}%`;
  if (/[€£¥$]/.test(format)) {
    const symbol = format.match(/[€£¥$]/)?.[0] ?? '';
    return `${symbol}${number.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
  }
  return value;
}

function xlsxCell(
  cell: ElementNode,
  strings: string[],
  styles: WorkbookStyles,
  date1904: boolean,
): XlsxCell {
  const formula = firstChild(cell.children, 'f');
  if (formula) {
    const value = textContent(formula.children).trim();
    return { display: value ? `=${value}` : 'Formula', type: 'formula' };
  }
  const type = attr(cell, 't') ?? 'n';
  const raw = textContent(firstChild(cell.children, 'v')?.children ?? []);
  let display = raw;
  let resultType: XlsxCell['type'] = 'number';
  if (type === 's') {
    const index = Number(raw);
    display = Number.isInteger(index) && strings[index] !== undefined ? strings[index]! : '';
    resultType = 'text';
  } else if (type === 'inlineStr') {
    display = descendants(cell.children, 't').map((text) => textContent(text.children)).join('');
    resultType = 'text';
  } else if (type === 'str') {
    resultType = 'text';
  } else if (type === 'b') {
    display = raw === '1' ? 'TRUE' : 'FALSE';
    resultType = 'boolean';
  } else if (type === 'e') {
    resultType = 'error';
  } else if (type === 'd') {
    resultType = 'date';
  } else if (!raw) {
    resultType = 'blank';
  } else {
    const styleIndex = Number(attr(cell, 's') ?? 0);
    const format = styles.formats.get(styleIndex) ?? '';
    if (styles.dateStyles.has(styleIndex)) {
      const date = excelDate(Number(raw), date1904, /[his]/i.test(format));
      if (date) {
        display = date;
        resultType = 'date';
      }
    } else {
      display = numberDisplay(raw, format);
    }
  }
  if (display.length > CELL_TEXT_LIMIT) display = `${display.slice(0, CELL_TEXT_LIMIT)}…`;
  return { display, type: resultType };
}

async function parseSheet(
  zip: JSZip,
  path: string,
  name: string,
  state: XlsxSheet['state'],
  strings: string[],
  styles: WorkbookStyles,
  date1904: boolean,
): Promise<XlsxSheet> {
  const xml = await readXml(zip, path);
  const root = firstChild(parseXml(xml!, `XLSX sheet ${name}`), 'worksheet');
  if (!root) throw new Error(`The sheet “${name}” is invalid.`);
  const sheetData = firstChild(root.children, 'sheetData');
  const rows: XlsxRow[] = [];
  let cellsSeen = 0;
  let truncated = false;
  for (const row of childElements(sheetData?.children ?? [], 'row')) {
    const number = Number(attr(row, 'r') ?? rows.length + 1);
    if (!Number.isInteger(number) || number < 1) continue;
    if (number > XLSX_MAX_ROWS_PER_SHEET || rows.length >= XLSX_MAX_ROWS_PER_SHEET) {
      truncated = true;
      continue;
    }
    const cells: XlsxCell[] = [];
    for (const cell of childElements(row.children, 'c')) {
      if (cellsSeen >= XLSX_MAX_CELLS_PER_SHEET) {
        truncated = true;
        break;
      }
      const reference = attr(cell, 'r') ?? '';
      const column = columnIndex(reference);
      const cellRow = rowIndex(reference);
      if (column === null || cellRow !== number || column >= XLSX_MAX_COLUMNS) {
        if (column !== null && column >= XLSX_MAX_COLUMNS) truncated = true;
        continue;
      }
      while (cells.length < column) cells.push({ display: '', type: 'blank' });
      cells[column] = xlsxCell(cell, strings, styles, date1904);
      cellsSeen += 1;
    }
    rows.push({ index: number, cells });
  }
  return { name, state, rows, truncated };
}

async function parseXlsx(zip: JSZip): Promise<XlsxPreview> {
  const [workbookXml, relationships, strings, styles] = await Promise.all([
    readXml(zip, 'xl/workbook.xml'),
    workbookRelationships(zip),
    sharedStrings(zip),
    workbookStyles(zip),
  ]);
  const root = firstChild(parseXml(workbookXml!, 'XLSX workbook'), 'workbook');
  const workbookProperties = firstChild(root?.children ?? [], 'workbookPr');
  const date1904 = ['1', 'true'].includes((attr(workbookProperties, 'date1904') ?? '').toLowerCase());
  const sheetsNode = firstChild(root?.children ?? [], 'sheets');
  const definitions = childElements(sheetsNode?.children ?? [], 'sheet');
  if (!definitions.length) throw new Error('This XLSX workbook does not contain any sheets.');
  const truncated = definitions.length > XLSX_MAX_SHEETS;
  const sheets: XlsxSheet[] = [];
  for (const definition of definitions.slice(0, XLSX_MAX_SHEETS)) {
    const name = attr(definition, 'name') ?? `Sheet ${sheets.length + 1}`;
    const relationshipId = attr(definition, 'id');
    const path = relationshipId ? relationships.get(relationshipId) : undefined;
    if (!path || !path.startsWith('xl/worksheets/') || !path.endsWith('.xml')) continue;
    const rawState = attr(definition, 'state');
    const state: XlsxSheet['state'] = rawState === 'hidden' || rawState === 'veryHidden' ? rawState : 'visible';
    sheets.push(await parseSheet(zip, path, name, state, strings, styles, date1904));
  }
  if (!sheets.length) throw new Error('This XLSX workbook does not contain readable worksheets.');
  return { kind: 'xlsx', sheets, truncated: truncated || sheets.some((sheet) => sheet.truncated) };
}

export async function previewOfficeBuffer(input: ArrayBuffer | Uint8Array, fileName: string): Promise<OfficePreview> {
  const kind = officeFileKind(fileName);
  if (!kind) throw new Error('Only DOCX and XLSX files have an office preview.');
  const zip = await loadOfficeZip(input, kind);
  return kind === 'docx' ? parseDocx(zip) : parseXlsx(zip);
}

export async function fetchOfficePreview(url: string, fileName: string, signal?: AbortSignal): Promise<OfficePreview> {
  const response = await fetch(url, { credentials: 'same-origin', signal });
  if (!response.ok) throw new Error(`Preview could not load (${response.status}).`);
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > OFFICE_MAX_PACKAGE_BYTES) {
    throw new Error('This file is too large to preview safely. Download it to view the full file.');
  }
  const buffer = await response.arrayBuffer();
  return previewOfficeBuffer(buffer, fileName);
}
