import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildDocxBuffer,
  sanitizeXmlText,
  validateDocxBuffer,
  writeDocxAtomic,
} from '../../installer/veneer-docx/veneer-docx.mjs';
import { provisionVeneerOffice } from '../../installer/provision-veneer-office.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const xlsxScript = path.join(appRoot, 'installer', 'veneer-xlsx', 'veneer-xlsx.py');
const temporaryDirectories: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veneer-office-test-'));
  temporaryDirectories.push(dir);
  return dir;
}

function runXlsx(input: string | Buffer, args: string[]) {
  return spawnSync('python3', [xlsxScript, ...args], {
    input,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('veneer-docx', () => {
  it('converts common business Markdown and validates the OOXML package', async () => {
    const dir = tempDir();
    const image = path.join(dir, 'pixel.png');
    fs.writeFileSync(image, Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ));
    const markdown = `# Quarterly Report

This has **bold**, *italic*, ~~removed~~, \`code\`, and [a link](https://example.com).

- First item
  - Nested item

1. One
2. Two

| Name | Amount |
| --- | ---: |
| Alpha | 42 |

![Pixel](pixel.png)

<!-- pagebreak -->

## Notes

> A useful quote.
`;
    const buffer = await buildDocxBuffer(markdown, { title: 'Quarterly Report', inputDir: dir });
    await expect(validateDocxBuffer(buffer)).resolves.toBe(true);
    const zip = await JSZip.loadAsync(buffer);
    const documentXml = await zip.file('word/document.xml')!.async('string');
    const relationships = await zip.file('word/_rels/document.xml.rels')!.async('string');
    expect(documentXml).toContain('Quarterly Report');
    expect(documentXml).toContain('<w:tbl>');
    expect(documentXml).toContain('w:type="page"');
    expect(documentXml).toContain('<w:b/>');
    expect(documentXml).toContain('<w:i/>');
    expect(documentXml).toContain('<w:drawing>');
    expect(relationships).toContain('https://example.com');
  });

  it('preserves Unicode, replaces invalid XML controls, and keeps an existing file on validation failure', async () => {
    expect(sanitizeXmlText('café 😀\u0001done')).toBe('café 😀�done');
    const buffer = await buildDocxBuffer('# café 😀\u0001done');
    const zip = await JSZip.loadAsync(buffer);
    expect(await zip.file('word/document.xml')!.async('string')).toContain('café 😀�done');

    const output = path.join(tempDir(), 'existing.docx');
    fs.writeFileSync(output, 'keep-me');
    await expect(writeDocxAtomic(output, Buffer.from('not a package'))).rejects.toThrow('not a ZIP package');
    expect(fs.readFileSync(output, 'utf8')).toBe('keep-me');
    expect(fs.readdirSync(path.dirname(output)).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });
});

describe('veneer-xlsx', () => {
  it('creates a styled CSV workbook without converting formula-like text into formulas', async () => {
    const output = path.join(tempDir(), 'safe.xlsx');
    const result = runXlsx(
      'Name,Amount,Active,Date,Text\nAlice,12.5,true,2026-08-05,=2+2\nBob,00123,false,2026-08-06,+SUM(A1:A2)\nC,3,true,2026-08-07,-10\nD,4,false,2026-08-08,@cmd\n',
      ['--from', 'csv', '--sheet-name', 'Data', '-o', output],
    );
    expect(result.status, result.stderr).toBe(0);
    const zip = await JSZip.loadAsync(fs.readFileSync(output));
    const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    const strings = await zip.file('xl/sharedStrings.xml')!.async('string');
    expect(sheet).not.toContain('<f>');
    expect(strings).toContain('=2+2');
    expect(strings).toContain('+SUM(A1:A2)');
    expect(strings).toContain('-10');
    expect(strings).toContain('@cmd');
    expect(sheet).toContain('<autoFilter');
    expect(sheet).toContain('<pane ySplit="1"');
  });

  it('supports typed multi-sheet JSON, explicit formulas, formats, and charts', async () => {
    const output = path.join(tempDir(), 'structured.xlsx');
    const input = JSON.stringify({
      properties: { title: 'Sales report', author: 'Veneer' },
      sheets: [
        {
          name: 'Sales',
          columns: [
            { key: 'month', header: 'Month', width: 14 },
            { key: 'revenue', header: 'Revenue', format: 'currency' },
            { key: 'forecast', header: 'Forecast', format: 'currency' },
          ],
          rows: [
            { month: 'July', revenue: 1250.5, forecast: { formula: '=B2*1.1', result: 1375.55 } },
          ],
          charts: [{
            type: 'column',
            title: 'Revenue',
            series: [{ name: 'Revenue', categories: '=Sales!$A$2:$A$2', values: '=Sales!$B$2:$B$2' }],
            position: 'E2',
          }],
        },
        {
          name: 'Notes',
          columns: ['Text', 'When', 'Timestamp'],
          rows: [['Ready', { type: 'date', value: '2026-08-05' }, { type: 'datetime', value: '2026-08-05T14:30:00Z' }]],
        },
      ],
    });
    const result = runXlsx(input, ['--from', 'json', '-o', output]);
    expect(result.status, result.stderr).toBe(0);
    const zip = await JSZip.loadAsync(fs.readFileSync(output));
    const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    const workbook = await zip.file('xl/workbook.xml')!.async('string');
    expect(sheet).toContain('<f>B2*1.1</f>');
    expect(workbook).toContain('name="Sales"');
    expect(workbook).toContain('name="Notes"');
    expect(zip.file('xl/charts/chart1.xml')).not.toBeNull();
  });

  it('handles Unicode and control characters safely', async () => {
    const output = path.join(tempDir(), 'unicode.xlsx');
    const result = runXlsx(Buffer.from('Name,Value\ncafé 😀,a\u0001b\n'), ['--from', 'csv', '-o', output]);
    expect(result.status, result.stderr).toBe(0);
    const zip = await JSZip.loadAsync(fs.readFileSync(output));
    const strings = await zip.file('xl/sharedStrings.xml')!.async('string');
    expect(strings).toContain('café 😀');
    expect(strings).toContain('a�b');
  });

  it('rejects bad sheet names and Excel column overflow without replacing an existing output', () => {
    const dir = tempDir();
    const output = path.join(dir, 'existing.xlsx');
    fs.writeFileSync(output, 'keep-me');
    const badName = runXlsx(JSON.stringify({ sheets: [{ name: 'bad/name', rows: [['A'], ['B']] }] }), ['--from', 'json', '-o', output]);
    expect(badName.status).toBe(1);
    expect(badName.stderr).toContain('invalid character');
    expect(fs.readFileSync(output, 'utf8')).toBe('keep-me');

    // Exercise the real limit branch with a small unit probe. Sending a
    // 16,385-column JSON value through spawnSync can fill its input pipe when
    // the full Vitest suite is heavily parallel, which tests Node's pipe
    // behavior instead of this converter.
    const limitProbe = spawnSync('python3', ['-c', `
import importlib.util
spec = importlib.util.spec_from_file_location("veneer_xlsx", ${JSON.stringify(xlsxScript)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.MAX_COLUMNS = 2
try:
    module.normalize_columns({"columns": ["a", "b", "c"]}, [])
except module.InputError as error:
    assert "2-column limit" in str(error)
else:
    raise AssertionError("column overflow was accepted")
`], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    expect(limitProbe.status, limitProbe.stderr).toBe(0);
    expect(fs.readFileSync(output, 'utf8')).toBe('keep-me');
    expect(fs.readdirSync(dir).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });
});

describe('veneer office provisioning', () => {
  it('installs both commands, their pinned library, and an idempotent PATH entry', () => {
    const serviceHome = tempDir();
    const installerDir = path.join(appRoot, 'installer');
    provisionVeneerOffice({ serviceHome, installerDir });
    provisionVeneerOffice({ serviceHome, installerDir });
    const binDir = path.join(serviceHome, '.local', 'bin');
    const env = fs.readFileSync(path.join(serviceHome, '.config', 'veneer-pro', 'env'), 'utf8');
    expect(env.match(new RegExp(binDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(1);
    expect(fs.statSync(path.join(binDir, 'veneer-docx')).mode & 0o111).not.toBe(0);
    expect(fs.statSync(path.join(binDir, 'veneer-xlsx')).mode & 0o111).not.toBe(0);
    expect(fs.existsSync(path.join(
      serviceHome,
      '.local',
      'lib',
      'veneer-office',
      'veneer-xlsx',
      'vendor',
      'xlsxwriter-3.2.9-py3-none-any.whl',
    ))).toBe(true);
    expect(spawnSync(path.join(binDir, 'veneer-docx'), ['--help'], { encoding: 'utf8' }).status).toBe(0);
    expect(spawnSync(path.join(binDir, 'veneer-xlsx'), ['--help'], { encoding: 'utf8' }).status).toBe(0);
  });
});
