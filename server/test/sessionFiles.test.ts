import { describe, expect, it } from 'vitest';
import { collectSessionFileRefs } from '../src/providers/claude/sessionFiles.js';

const row = (blocks: unknown[], cwd?: string): string =>
  JSON.stringify({ type: 'assistant', message: { content: blocks }, ...(cwd ? { cwd } : {}) });
const write = (file_path: string) => ({ type: 'tool_use', name: 'Write', input: { file_path, content: 'x' } });
const bash = (command: string, id?: string) => ({ type: 'tool_use', name: 'Bash', ...(id ? { id } : {}), input: { command } });
const result = (
  tool_use_id: string,
  content: unknown,
  options: {
    cwd?: string;
    is_error?: boolean;
    stdout?: string;
    interrupted?: boolean;
    status?: string;
    exitCode?: number;
  } = {},
): string =>
  JSON.stringify({
    type: 'user',
    ...(options.cwd ? { cwd: options.cwd } : {}),
    message: { content: [{ type: 'tool_result', tool_use_id, content, ...(options.is_error ? { is_error: true } : {}) }] },
    toolUseResult: {
      ...(options.stdout !== undefined ? { stdout: options.stdout } : {}),
      ...(options.interrupted !== undefined ? { interrupted: options.interrupted } : {}),
      ...(options.status !== undefined ? { status: options.status } : {}),
      ...(options.exitCode !== undefined ? { exitCode: options.exitCode } : {}),
    },
  });

describe('collectSessionFileRefs', () => {
  it('collects Write tool calls for watched extensions, resolving against cwd', () => {
    const content = [row([write('/tmp/out/report.csv')]), row([write('notes.json')])].join('\n');
    expect(collectSessionFileRefs(content, '/work')).toEqual([
      { path: '/tmp/out/report.csv', source: 'write' },
      { path: '/work/notes.json', source: 'write' },
    ]);
  });

  it('ignores Write calls for non-deliverable extensions', () => {
    const content = row([write('/work/src/index.ts'), write('/work/debug.log')]);
    expect(collectSessionFileRefs(content, '/work')).toEqual([]);
  });

  it('treats widened text extensions (.html/.svg/.xls) as Write deliverables', () => {
    const content = row([write('/work/report.html'), write('/work/chart.svg'), write('/work/legacy.xls')]);
    expect(collectSessionFileRefs(content, '/work')).toEqual([
      { path: '/work/report.html', source: 'write' },
      { path: '/work/chart.svg', source: 'write' },
      { path: '/work/legacy.xls', source: 'write' },
    ]);
  });

  it('does not treat binary formats as Write deliverables (Write is text-only)', () => {
    const content = row([write('/work/out.pdf'), write('/work/deck.pptx'), write('/work/pic.png')]);
    expect(collectSessionFileRefs(content, '/work')).toEqual([]);
  });

  it('sniffs binary deliverables (pdf/png) out of Bash commands', () => {
    const content = row([bash('pandoc report.md -o report.pdf && python plot.py > chart.png')]);
    expect(collectSessionFileRefs(content, '/work')).toEqual([
      { path: '/work/report.pdf', source: 'bash' },
      { path: '/work/chart.png', source: 'bash' },
    ]);
  });

  it('sniffs copied font deliverables out of Bash commands', () => {
    const content = row([bash('cp /uploads/AuthBox.otf /Users/tester/Downloads/AuthBox.otf')]);
    expect(collectSessionFileRefs(content, '/work')).toEqual([
      { path: '/uploads/AuthBox.otf', source: 'bash' },
      { path: '/Users/tester/Downloads/AuthBox.otf', source: 'bash' },
    ]);
  });

  it('uses a successful Bash result to expand dynamic names in the result cwd', () => {
    const content = [
      row(
        [
          bash(
            'cd /work/reports && for out in CEO CFO COO; do render --output="$out.pdf"; done',
            'toolu_render',
          ),
        ],
        '/work',
      ),
      result(
        'toolu_render',
        'CEO-Daily-Pulse-Sample.pdf\nCFO-Daily-Finance-Brief-Sample.pdf\nCOO-Daily-Operations-Brief-Sample.pdf',
        {
          cwd: '/work/reports',
          stdout:
            'CEO-Daily-Pulse-Sample.pdf\nCFO-Daily-Finance-Brief-Sample.pdf\nCOO-Daily-Operations-Brief-Sample.pdf',
        },
      ),
    ].join('\n');

    expect(collectSessionFileRefs(content, '/work')).toEqual([
      { path: '/work/reports/CEO-Daily-Pulse-Sample.pdf', source: 'bash' },
      { path: '/work/reports/CFO-Daily-Finance-Brief-Sample.pdf', source: 'bash' },
      { path: '/work/reports/COO-Daily-Operations-Brief-Sample.pdf', source: 'bash' },
    ]);
  });

  it('uses each assistant row cwd for literal Bash paths', () => {
    const content = row([bash('render -o report.pdf')], '/work/reports');
    expect(collectSessionFileRefs(content, '/work')).toEqual([{ path: '/work/reports/report.pdf', source: 'bash' }]);
  });

  it('accepts structured result text, strips ANSI, and preserves quoted paths with spaces', () => {
    const content = [
      row([bash('render --output="$out.pdf"', 'toolu_space')]),
      result('toolu_space', [{ type: 'text', text: '\u001b[32m"Quarterly Report.pdf"\u001b[0m' }], {
        cwd: '/work/reports',
      }),
    ].join('\n');
    expect(collectSessionFileRefs(content, '/work')).toEqual([
      { path: '/work/reports/Quarterly Report.pdf', source: 'bash' },
    ]);
  });

  it('links results by tool id even when rows are out of order and dedups command/result mentions', () => {
    const content = [
      result('toolu_late', 'report.pdf', { cwd: '/work/out', stdout: 'report.pdf' }),
      row([bash('render -o /work/out/report.pdf', 'toolu_late')]),
    ].join('\n');
    expect(collectSessionFileRefs(content, '/work')).toEqual([{ path: '/work/out/report.pdf', source: 'bash' }]);
  });

  it('rejects failed, interrupted, nonzero, and explicit failed Bash results', () => {
    const content = [
      row([
        bash('render "$bad1.pdf"', 'bad-error'),
        bash('render "$bad2.pdf"', 'bad-interrupted'),
        bash('render "$bad3.pdf"', 'bad-exit'),
        bash('render "$bad4.pdf"', 'bad-status'),
        bash('render "$good.pdf"', 'good'),
      ]),
      result('bad-error', 'bad-error.pdf', { is_error: true, stdout: 'bad-error.pdf' }),
      result('bad-interrupted', 'bad-interrupted.pdf', { interrupted: true, stdout: 'bad-interrupted.pdf' }),
      result('bad-exit', 'bad-exit.pdf', { exitCode: 1, stdout: 'bad-exit.pdf' }),
      result('bad-status', 'bad-status.pdf', { status: 'failed', stdout: 'bad-status.pdf' }),
      // Real successful Claude Bash results often have no explicit status.
      result('good', 'good.pdf', { stdout: 'good.pdf' }),
    ].join('\n');
    expect(collectSessionFileRefs(content, '/work')).toEqual([{ path: '/work/good.pdf', source: 'bash' }]);
  });

  it('ignores unmatched, non-Bash, ambiguous, and no-producer result output', () => {
    const content = [
      row([
        { type: 'tool_use', id: 'read-id', name: 'Read', input: { file_path: '/work/input.pdf' } },
        bash('ls', 'plain-bash'),
        bash('render "$out.pdf"', 'duplicate-id'),
        { type: 'tool_use', id: 'duplicate-id', name: 'Read', input: { file_path: '/work/other.pdf' } },
      ]),
      result('missing-id', 'missing.pdf', { stdout: 'missing.pdf' }),
      result('read-id', 'read-output.pdf', { stdout: 'read-output.pdf' }),
      result('plain-bash', 'listed.pdf', { stdout: 'listed.pdf' }),
      result('duplicate-id', 'ambiguous.pdf', { stdout: 'ambiguous.pdf' }),
    ].join('\n');
    expect(collectSessionFileRefs(content, '/work')).toEqual([]);
  });

  it('bounds Bash result candidates and ignores URL mentions', () => {
    const names = Array.from({ length: 140 }, (_, i) => `file-${String(i).padStart(3, '0')}.pdf`);
    const content = [
      row([bash('render "$out.pdf"', 'many')]),
      result('many', names.concat('https://example.com/remote.pdf').join('\n'), {
        stdout: names.concat('https://example.com/remote.pdf').join('\n'),
      }),
    ].join('\n');
    const refs = collectSessionFileRefs(content, '/work');
    expect(refs).toHaveLength(128);
    expect(refs[0]).toEqual({ path: '/work/file-000.pdf', source: 'bash' });
    expect(refs.at(-1)).toEqual({ path: '/work/file-127.pdf', source: 'bash' });
  });

  it('expands ~ against the provided home', () => {
    const content = row([write('~/exports/data.csv')]);
    expect(collectSessionFileRefs(content, '/work', '/home/u')).toEqual([
      { path: '/home/u/exports/data.csv', source: 'write' },
    ]);
  });

  it('sniffs csv/tsv/xlsx paths out of Bash commands but not .json mentions', () => {
    const content = row([bash('python gen.py > sales.csv && cat package.json')]);
    expect(collectSessionFileRefs(content, '/work')).toEqual([{ path: '/work/sales.csv', source: 'bash' }]);
  });

  it('dedups, with an exact Write beating a Bash mention of the same path', () => {
    const content = [row([bash('head -5 /work/a.csv')]), row([write('/work/a.csv')])].join('\n');
    expect(collectSessionFileRefs(content, '/work')).toEqual([{ path: '/work/a.csv', source: 'write' }]);
  });

  it('survives malformed lines and non-assistant rows', () => {
    const content = ['not json', JSON.stringify({ type: 'user', message: { content: 'make a csv' } }), row([write('/x/a.csv')])].join(
      '\n',
    );
    expect(collectSessionFileRefs(content, '/work')).toEqual([{ path: '/x/a.csv', source: 'write' }]);
  });
});
