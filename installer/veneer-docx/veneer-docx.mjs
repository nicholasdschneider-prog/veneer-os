#!/usr/bin/env node
// veneer-docx — turn Markdown into a clean Microsoft Word document.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  PageBreak,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import JSZip from 'jszip';
import { marked } from 'marked';

const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const BODY_FONT = 'Inter';
const HEADING_FONT = 'Georgia';
const PRIMARY = '26221C';
const ACCENT = '8A6D47';
const PANEL = 'F0E7D8';
const MUTED = '6F675C';

const HELP = `veneer-docx — make a DOCX file from Markdown.

Usage:
  veneer-docx <input.md> [-o output.docx] [--title "..."]
  cat report.md | veneer-docx -o /absolute/path/report.docx

Markdown support includes headings, emphasis, lists, tables, links, code,
quotes, local PNG/JPEG/GIF/BMP images, and <!-- pagebreak --> markers.`;

export function parseArgs(argv) {
  const options = { input: '-', output: undefined, title: undefined, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '-o' || arg === '--output') {
      if (!argv[i + 1]) throw new Error(`${arg} needs a path`);
      options.output = argv[++i];
    } else if (arg === '--title') {
      if (!argv[i + 1]) throw new Error('--title needs text');
      options.title = argv[++i];
    } else if (arg === '-' || !arg.startsWith('-')) {
      if (options.input !== '-') throw new Error(`unexpected argument: ${arg}`);
      options.input = arg;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return options;
}

export function resolveOutputPath(options) {
  const raw = options.output
    ?? (options.input && options.input !== '-'
      ? `${path.basename(options.input, path.extname(options.input))}.docx`
      : `document-${crypto.randomUUID().slice(0, 8)}.docx`);
  const resolved = path.resolve(raw);
  if (path.extname(resolved).toLowerCase() !== '.docx') throw new Error('output path must end in .docx');
  return resolved;
}

export function sanitizeXmlText(value) {
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '\ufffd');
}

function textRun(text, style = {}) {
  return new TextRun({
    text: sanitizeXmlText(text),
    font: style.code ? 'Courier New' : BODY_FONT,
    bold: Boolean(style.bold),
    italics: Boolean(style.italics),
    strike: Boolean(style.strike),
    color: style.link ? ACCENT : PRIMARY,
    underline: style.link ? {} : undefined,
    break: style.break,
  });
}

function imageType(data, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (data[0] === 0xff && data[1] === 0xd8) return 'jpg';
  if (data.subarray(0, 3).toString('ascii') === 'GIF') return 'gif';
  if (data.subarray(0, 2).toString('ascii') === 'BM') return 'bmp';
  if (ext === '.jpg' || ext === '.jpeg') return 'jpg';
  if (['.png', '.gif', '.bmp'].includes(ext)) return ext.slice(1);
  throw new Error(`unsupported image type: ${filePath}`);
}

function jpegDimensions(data) {
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) { offset += 1; continue; }
    const marker = data[offset + 1];
    const length = data.readUInt16BE(offset + 2);
    if (length < 2) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) };
    }
    offset += length + 2;
  }
  return null;
}

function imageDimensions(data, type) {
  if (type === 'png' && data.length >= 24) return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (type === 'gif' && data.length >= 10) return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  if (type === 'bmp' && data.length >= 26) return { width: data.readUInt32LE(18), height: Math.abs(data.readInt32LE(22)) };
  if (type === 'jpg') return jpegDimensions(data);
  return null;
}

function localImageRun(token, inputDir) {
  const href = String(token.href ?? '');
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('file://')) {
    return textRun(`[Image: ${token.text || href}]`, { italics: true });
  }
  let target = href.startsWith('file://') ? decodeURIComponent(href.slice('file://'.length)) : decodeURIComponent(href);
  target = path.isAbsolute(target) ? path.normalize(target) : path.resolve(inputDir, target);
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw new Error(`image is not a file: ${target}`);
  if (stat.size > MAX_IMAGE_BYTES) throw new Error(`image is larger than 10 MB: ${target}`);
  const data = fs.readFileSync(target);
  const type = imageType(data, target);
  const dimensions = imageDimensions(data, type) ?? { width: 800, height: 450 };
  const scale = Math.min(1, 560 / dimensions.width, 700 / dimensions.height);
  return new ImageRun({
    type,
    data,
    transformation: {
      width: Math.max(1, Math.round(dimensions.width * scale)),
      height: Math.max(1, Math.round(dimensions.height * scale)),
    },
    altText: {
      title: sanitizeXmlText(token.title || token.text || 'Image'),
      description: sanitizeXmlText(token.text || ''),
      name: sanitizeXmlText(path.basename(target)),
    },
  });
}

function inlineChildren(tokens = [], context = {}, style = {}) {
  const children = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'text':
      case 'escape':
        if (token.tokens) children.push(...inlineChildren(token.tokens, context, style));
        else children.push(textRun(token.text ?? token.raw ?? '', style));
        break;
      case 'strong':
        children.push(...inlineChildren(token.tokens, context, { ...style, bold: true }));
        break;
      case 'em':
        children.push(...inlineChildren(token.tokens, context, { ...style, italics: true }));
        break;
      case 'del':
        children.push(...inlineChildren(token.tokens, context, { ...style, strike: true }));
        break;
      case 'codespan':
        children.push(textRun(token.text ?? '', { ...style, code: true }));
        break;
      case 'br':
        children.push(textRun('', { ...style, break: 1 }));
        break;
      case 'link': {
        const href = String(token.href ?? '');
        const linkChildren = inlineChildren(token.tokens, context, { ...style, link: true });
        try {
          const link = new URL(href);
          if (['http:', 'https:', 'mailto:'].includes(link.protocol)) {
            children.push(new ExternalHyperlink({ link: link.href, children: linkChildren }));
          } else children.push(...linkChildren);
        } catch {
          children.push(...linkChildren);
        }
        break;
      }
      case 'image':
        children.push(localImageRun(token, context.inputDir));
        break;
      default:
        children.push(textRun(token.text ?? token.raw ?? '', style));
    }
  }
  return children;
}

function paragraphFromInline(tokens, options = {}) {
  return new Paragraph({
    children: inlineChildren(tokens, options.context, options.runStyle),
    heading: options.heading,
    bullet: options.bullet,
    numbering: options.numbering,
    indent: options.indent,
    spacing: options.spacing ?? { after: 140, line: 276 },
    border: options.border,
    shading: options.shading,
    keepNext: options.keepNext,
  });
}

function listChildren(token, context, level = 0) {
  const output = [];
  for (const item of token.items ?? []) {
    let wrotePrimary = false;
    for (const child of item.tokens ?? []) {
      if (child.type === 'list') {
        output.push(...listChildren(child, context, Math.min(level + 1, 8)));
        continue;
      }
      const tokens = child.tokens ?? marked.lexer(child.text ?? child.raw ?? '')[0]?.tokens ?? [];
      const prefix = item.task ? [textRun(item.checked ? '\u2612 ' : '\u2610 ')] : [];
      const inline = wrotePrimary ? tokens : [{ type: 'text', tokens: [...prefix.map((run) => ({ type: '__run', run })), ...tokens] }];
      const actualChildren = [];
      for (const inlineToken of inline) {
        if (inlineToken.type === '__run') actualChildren.push(inlineToken.run);
        else if (inlineToken.tokens) {
          for (const nested of inlineToken.tokens) {
            if (nested.type === '__run') actualChildren.push(nested.run);
            else actualChildren.push(...inlineChildren([nested], context));
          }
        } else actualChildren.push(...inlineChildren([inlineToken], context));
      }
      output.push(new Paragraph({
        children: actualChildren,
        bullet: !token.ordered && !wrotePrimary ? { level } : undefined,
        numbering: token.ordered && !wrotePrimary ? { reference: 'veneer-numbering', level } : undefined,
        indent: wrotePrimary ? { left: 720 * (level + 1) } : undefined,
        spacing: { after: 80, line: 276 },
      }));
      wrotePrimary = true;
    }
    if (!wrotePrimary) {
      output.push(new Paragraph({
        text: '',
        bullet: token.ordered ? undefined : { level },
        numbering: token.ordered ? { reference: 'veneer-numbering', level } : undefined,
      }));
    }
  }
  return output;
}

function tableFromToken(token, context) {
  const makeCell = (cell, header) => new TableCell({
    width: { size: Math.max(1, Math.floor(100 / Math.max(1, token.header.length))), type: WidthType.PERCENTAGE },
    shading: header ? { type: ShadingType.CLEAR, fill: PANEL, color: 'auto' } : undefined,
    margins: { top: 90, bottom: 90, left: 120, right: 120 },
    children: [new Paragraph({
      children: inlineChildren(cell.tokens, context, header ? { bold: true } : {}),
      spacing: { after: 0, line: 250 },
    })],
  });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.AUTOFIT,
    rows: [
      new TableRow({ tableHeader: true, children: token.header.map((cell) => makeCell(cell, true)) }),
      ...(token.rows ?? []).map((row) => new TableRow({ children: row.map((cell) => makeCell(cell, false)) })),
    ],
  });
}

function blockChildren(tokens, context) {
  const output = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'space':
        break;
      case 'heading':
        output.push(paragraphFromInline(token.tokens, {
          context,
          heading: HeadingLevel[`HEADING_${Math.min(token.depth, 6)}`],
          spacing: { before: token.depth === 1 ? 220 : 160, after: 100 },
          keepNext: true,
        }));
        break;
      case 'paragraph':
      case 'text': {
        const raw = String(token.text ?? token.raw ?? '').trim();
        if (/^(?:\\pagebreak|\{\{pagebreak\}\})$/i.test(raw)) output.push(new Paragraph({ children: [new PageBreak()] }));
        else output.push(paragraphFromInline(token.tokens ?? marked.lexer(raw)[0]?.tokens ?? [], { context }));
        break;
      }
      case 'list':
        output.push(...listChildren(token, context));
        break;
      case 'table':
        output.push(tableFromToken(token, context));
        output.push(new Paragraph({ text: '', spacing: { after: 60 } }));
        break;
      case 'blockquote': {
        const quoteChildren = blockChildren(token.tokens ?? [], context);
        for (const child of quoteChildren) {
          if (child instanceof Paragraph) {
            output.push(new Paragraph({
              children: [textRun(token.text ?? token.raw ?? '', { italics: true })],
              indent: { left: 360, right: 180 },
              border: { left: { style: BorderStyle.SINGLE, color: ACCENT, size: 18, space: 8 } },
              shading: { type: ShadingType.CLEAR, fill: PANEL, color: 'auto' },
              spacing: { before: 80, after: 100, line: 276 },
            }));
            break;
          }
        }
        break;
      }
      case 'code':
        for (const line of String(token.text ?? '').split('\n')) {
          output.push(new Paragraph({
            children: [textRun(line || ' ', { code: true })],
            shading: { type: ShadingType.CLEAR, fill: 'F5F1EA', color: 'auto' },
            indent: { left: 180, right: 180 },
            spacing: { after: 0, line: 240 },
          }));
        }
        output.push(new Paragraph({ text: '', spacing: { after: 100 } }));
        break;
      case 'hr':
        output.push(new Paragraph({
          children: [textRun('')],
          border: { bottom: { style: BorderStyle.SINGLE, color: ACCENT, size: 8, space: 8 } },
          spacing: { before: 100, after: 140 },
        }));
        break;
      case 'html':
        if (/page-?break/i.test(token.raw ?? token.text ?? '')) output.push(new Paragraph({ children: [new PageBreak()] }));
        break;
      default:
        if (token.tokens) output.push(...blockChildren(token.tokens, context));
        else if (token.text || token.raw) output.push(new Paragraph({ children: [textRun(token.text ?? token.raw)] }));
    }
  }
  return output;
}

function numberingLevels() {
  return Array.from({ length: 9 }, (_, level) => ({
    level,
    format: LevelFormat.DECIMAL,
    text: `%${level + 1}.`,
    alignment: AlignmentType.START,
    style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
  }));
}

export async function buildDocxBuffer(markdown, { title = 'Document', inputDir = process.cwd() } = {}) {
  if (!String(markdown).trim()) throw new Error('input is empty');
  const tokens = marked.lexer(String(markdown), { gfm: true });
  const children = blockChildren(tokens, { inputDir });
  if (!children.length) throw new Error('input has no document content');
  const document = new Document({
    title: sanitizeXmlText(title),
    creator: 'Veneer',
    description: 'Document created with Veneer',
    styles: {
      default: {
        document: { run: { font: BODY_FONT, size: 22, color: PRIMARY }, paragraph: { spacing: { after: 140, line: 276 } } },
        title: { run: { font: HEADING_FONT, size: 42, bold: true, color: PRIMARY }, paragraph: { spacing: { after: 220 } } },
        heading1: { run: { font: HEADING_FONT, size: 34, bold: true, color: PRIMARY }, paragraph: { spacing: { before: 240, after: 120 } } },
        heading2: { run: { font: HEADING_FONT, size: 28, bold: true, color: PRIMARY }, paragraph: { spacing: { before: 200, after: 100 } } },
        heading3: { run: { font: BODY_FONT, size: 24, bold: true, color: PRIMARY }, paragraph: { spacing: { before: 160, after: 80 } } },
        hyperlink: { run: { color: ACCENT, underline: {} } },
      },
    },
    numbering: { config: [{ reference: 'veneer-numbering', levels: numberingLevels() }] },
    sections: [{
      properties: { page: { margin: { top: 900, right: 900, bottom: 900, left: 900 } } },
      children,
    }],
  });
  return Packer.toBuffer(document);
}

export async function validateDocxBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 100 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    throw new Error('DOCX output is not a ZIP package');
  }
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
  for (const name of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml']) {
    if (!zip.file(name)) throw new Error(`DOCX output is missing ${name}`);
  }
  const documentXml = await zip.file('word/document.xml').async('string');
  if (!/<w:document[\s>]/.test(documentXml) || !/<w:body[\s>]/.test(documentXml)) {
    throw new Error('DOCX document XML is invalid');
  }
  return true;
}

export async function writeDocxAtomic(outputPath, buffer) {
  const output = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const temp = path.join(path.dirname(output), `.${path.basename(output)}.tmp-${process.pid}-${crypto.randomUUID()}`);
  try {
    fs.writeFileSync(temp, buffer, { flag: 'wx', mode: 0o600 });
    await validateDocxBuffer(fs.readFileSync(temp));
    fs.renameSync(temp, output);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* nothing to remove */ }
    throw error;
  }
  return output;
}

async function readInput(input) {
  if (input === '-') {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > MAX_INPUT_BYTES) throw new Error('input is larger than 32 MB');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const stat = fs.statSync(input);
  if (!stat.isFile()) throw new Error(`input is not a file: ${input}`);
  if (stat.size > MAX_INPUT_BYTES) throw new Error('input is larger than 32 MB');
  return fs.readFileSync(input, 'utf8');
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  const inputPath = options.input === '-' ? '-' : path.resolve(options.input);
  const markdown = await readInput(inputPath);
  const output = resolveOutputPath({ ...options, input: inputPath });
  const title = options.title ?? (inputPath === '-' ? 'Document' : path.basename(inputPath, path.extname(inputPath)));
  const buffer = await buildDocxBuffer(markdown, { title, inputDir: inputPath === '-' ? process.cwd() : path.dirname(inputPath) });
  await writeDocxAtomic(output, buffer);
  process.stderr.write('veneer-docx: created and validated DOCX.\n');
  process.stdout.write(`${output}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`veneer-docx: ${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  });
}
