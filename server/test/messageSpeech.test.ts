import { describe, expect, it } from 'vitest';
import { speechParts, spokenMarkdown } from '../src/bots/messageSpeech.js';

describe('full-message speech rendering', () => {
  it('reads tables with column labels and preserves material conditions', () => {
    const text = spokenMarkdown('# Access\n\n| Person | Access |\n| --- | --- |\n| Employees | Assigned bots only |\n| You | Full chats |\n\n**Cost:** $1,234.50, only if approved. [Evidence](https://example.test)');
    expect(text).toContain('Person: Employees. Access: Assigned bots only');
    expect(text).toContain('Person: You. Access: Full chats');
    expect(text).toContain('Cost: $1,234.50, only if approved. Evidence');
    expect(text).not.toContain('https://');
  });
  it('retains lists, quotes, code and image descriptions', () => {
    const text = spokenMarkdown('> Uncertain outcome.\n\n- First\n- Second\n\n```sh\necho example\n```\n\n![Diagram of access](image.png)');
    for (const part of ['Uncertain outcome.', 'First', 'Second', 'echo example', 'Diagram of access']) expect(text).toContain(part);
  });
  it('splits long and unbroken content without losing text or splitting surrogate pairs', () => {
    for (const text of ['A paragraph.\n'.repeat(1000), 'x'.repeat(9000), '🙂'.repeat(3000)]) {
      const parts = speechParts(text, 101);
      expect(parts.join('')).toBe(text);
      expect(parts.every(p => p.length <= 101)).toBe(true);
      expect(parts.every(p => !/[\uD800-\uDBFF]$/.test(p))).toBe(true);
    }
  });
});
