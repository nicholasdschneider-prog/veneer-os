import { describe, expect, it } from 'vitest';
import { inlineContentSecurityPolicy, inlineContentType } from '../src/routes/inlineContentType.js';

describe('office inline content types', () => {
  it('serves DOCX and XLSX with standard OOXML media types and no executable CSP exception', () => {
    const docx = inlineContentType('/tmp/Report.DOCX');
    const xlsx = inlineContentType('/tmp/Workbook.xlsx');
    expect(docx).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(xlsx).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(inlineContentSecurityPolicy(docx)).toBeNull();
    expect(inlineContentSecurityPolicy(xlsx)).toBeNull();
  });

  it('serves OpenType and TrueType fonts with standard media types', () => {
    expect(inlineContentType('/tmp/AuthBox.OTF')).toBe('font/otf');
    expect(inlineContentType('/tmp/AuthBox.ttf')).toBe('font/ttf');
  });
});

describe('HTML inline content security', () => {
  it.each(['/tmp/index.html', '/tmp/archive.HTM'])('serves %s as sandboxed HTML', (filePath) => {
    const contentType = inlineContentType(filePath);
    const policy = inlineContentSecurityPolicy(contentType);

    expect(contentType).toBe('text/html; charset=utf-8');
    expect(policy).toContain('sandbox');
    expect(policy).toContain('allow-scripts');
    expect(policy).not.toContain('allow-same-origin');
  });
});
