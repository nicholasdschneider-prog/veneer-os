import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { officeFileKind, previewOfficeBuffer } from './officePreview';

const CONTENT_TYPES = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types" />';

async function docxFixture(options?: { active?: boolean; doctype?: boolean }): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file(
    'word/document.xml',
    `${options?.doctype ? '<!DOCTYPE document [<!ENTITY unsafe "unsafe">]>' : ''}
    <w:document xmlns:w="word" xmlns:r="relationships"><w:body>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Résumé &amp; 東京</w:t></w:r></w:p>
      <w:p><w:hyperlink r:id="safe"><w:r><w:rPr><w:i/></w:rPr><w:t>Veneer</w:t></w:r></w:hyperlink><w:hyperlink r:id="unsafe"><w:r><w:t>unsafe</w:t></w:r></w:hyperlink></w:p>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First item</w:t></w:r></w:p>
      <w:tbl><w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc><w:p><w:r><w:t>Header</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      <w:p><w:r><w:br w:type="page"/></w:r></w:p>
    </w:body></w:document>`,
  );
  zip.file(
    'word/_rels/document.xml.rels',
    '<Relationships><Relationship Id="safe" Target="https://veneer.app/docs" TargetMode="External"/><Relationship Id="unsafe" Target="javascript:alert(1)" TargetMode="External"/></Relationships>',
  );
  zip.file(
    'word/numbering.xml',
    '<w:numbering xmlns:w="word"><w:abstractNum w:abstractNumId="9"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="9"/></w:num></w:numbering>',
  );
  if (options?.active) zip.file('word/vbaProject.bin', new Uint8Array([1, 2, 3]));
  return zip.generateAsync({ type: 'uint8array' });
}

async function xlsxFixture(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.file(
    'xl/workbook.xml',
    '<workbook xmlns:r="relationships"><workbookPr/><sheets><sheet name="Summary" sheetId="1" r:id="rId1"/><sheet name="東京" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>',
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
  );
  zip.file(
    'xl/sharedStrings.xml',
    '<sst><si><t>Name</t></si><si><t>=2+2</t></si><si><r><t>café </t></r><r><t>✓</t></r></si></sst>',
  );
  zip.file(
    'xl/styles.xml',
    '<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>',
  );
  zip.file(
    'xl/worksheets/sheet1.xml',
    '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2"><v>42</v></c><c r="B2" t="b"><v>1</v></c><c r="C2" s="1"><v>46239</v></c><c r="D2"><f>SUM(A2:A3)</f><v>999</v></c><c r="E2" t="s"><v>1</v></c><c r="F2" t="s"><v>2</v></c><c r="G2" s="1"><v>60</v></c></row><row r="2001"><c r="A2001"><v>1</v></c></row></sheetData></worksheet>',
  );
  zip.file(
    'xl/worksheets/sheet2.xml',
    '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Second sheet</t></is></c><c r="XFD1"><v>5</v></c></row></sheetData></worksheet>',
  );
  return zip.generateAsync({ type: 'uint8array' });
}

describe('office preview parsing', () => {
  it('detects only supported OOXML file names', () => {
    expect(officeFileKind('Report.DOCX')).toBe('docx');
    expect(officeFileKind('Book.xlsx')).toBe('xlsx');
    expect(officeFileKind('legacy.xls')).toBeNull();
    expect(officeFileKind('macro.docm')).toBeNull();
  });

  it('renders DOCX headings, emphasis, lists, tables, safe links, page breaks, and Unicode', async () => {
    const preview = await previewOfficeBuffer(await docxFixture(), 'report.docx');
    expect(preview.kind).toBe('docx');
    if (preview.kind !== 'docx') return;
    expect(preview.blocks[0]).toMatchObject({ kind: 'paragraph', style: 'heading1' });
    const heading = preview.blocks[0];
    if (heading?.kind !== 'paragraph') throw new Error('Expected the first block to be a paragraph.');
    expect(heading.runs[0]).toMatchObject({ text: 'Résumé & 東京', bold: true });
    const links = preview.blocks[1];
    if (links?.kind !== 'paragraph') throw new Error('Expected the second block to be a paragraph.');
    expect(links.runs).toEqual([
      expect.objectContaining({ text: 'Veneer', italic: true, href: 'https://veneer.app/docs' }),
      expect.objectContaining({ text: 'unsafe', href: undefined }),
    ]);
    expect(preview.blocks[2]).toMatchObject({ kind: 'paragraph', list: { level: 0, ordered: true } });
    const table = preview.blocks[3];
    expect(table).toMatchObject({ kind: 'table' });
    expect(table?.kind === 'table' ? table.rows[0]?.header : null).toBe(true);
    expect(preview.blocks[4]).toEqual({ kind: 'pageBreak' });
  });

  it('renders XLSX sheets, dates, numbers, booleans, Unicode, and formulas without calculation', async () => {
    const preview = await previewOfficeBuffer(await xlsxFixture(), 'workbook.xlsx');
    expect(preview.kind).toBe('xlsx');
    if (preview.kind !== 'xlsx') return;
    expect(preview.sheets.map((sheet) => [sheet.name, sheet.state])).toEqual([
      ['Summary', 'visible'],
      ['東京', 'hidden'],
    ]);
    expect(preview.sheets[0]!.rows[1]!.cells).toEqual([
      { display: '42', type: 'number' },
      { display: 'TRUE', type: 'boolean' },
      expect.objectContaining({ type: 'date' }),
      { display: '=SUM(A2:A3)', type: 'formula' },
      { display: '=2+2', type: 'text' },
      { display: 'café ✓', type: 'text' },
      { display: '1900-02-29', type: 'date' },
    ]);
    expect(preview.sheets[0]!.truncated).toBe(true);
    expect(preview.sheets[1]!.rows[0]!.cells[0]).toEqual({ display: 'Second sheet', type: 'text' });
    expect(preview.sheets[1]!.truncated).toBe(true);
    expect(preview.truncated).toBe(true);
  });

  it('rejects macros, unsafe XML declarations, invalid ZIP data, and mismatched packages', async () => {
    await expect(previewOfficeBuffer(await docxFixture({ active: true }), 'unsafe.docx')).rejects.toThrow(/active content/i);
    await expect(previewOfficeBuffer(await docxFixture({ doctype: true }), 'unsafe.docx')).rejects.toThrow(/XML declarations/i);
    await expect(previewOfficeBuffer(new Uint8Array([1, 2, 3]), 'bad.xlsx')).rejects.toThrow(/not a valid XLSX/i);
    await expect(previewOfficeBuffer(await docxFixture(), 'bad.xlsx')).rejects.toThrow(/missing xl\/workbook\.xml/i);
  });

  it('rejects a compressed package entry before it expands beyond the XML limit', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', CONTENT_TYPES);
    zip.file('word/document.xml', `<w:document><w:body><!--${'x'.repeat(8 * 1024 * 1024)}--></w:body></w:document>`);
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    expect(bytes.byteLength).toBeLessThan(100_000);
    await expect(previewOfficeBuffer(bytes, 'large.docx')).rejects.toThrow(/too large to preview safely/i);
  });
});
