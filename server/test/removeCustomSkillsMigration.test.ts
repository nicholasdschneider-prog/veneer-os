import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/db/migrations');

describe('remove custom skills migration', () => {
  it('keeps MCP connections and removes the retired skill rows and kind column', () => {
    const db = new Database(':memory:');
    try {
      db.exec(fs.readFileSync(path.join(MIGRATIONS, '0003_connections.sql'), 'utf8'));
      db.prepare(
        `INSERT INTO connections (kind, name, slug, config_json, policy_json)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('mcp', 'Shopify', 'shopify', JSON.stringify({ transport: 'stdio', command: 'shopify' }), '{}');
      db.prepare(
        `INSERT INTO connections (kind, name, slug, config_json, policy_json)
         VALUES (?, ?, ?, ?, ?)`,
      ).run('skill', 'Refund policy', 'refund_policy', JSON.stringify({ content: '# Refunds' }), '{}');

      db.exec(fs.readFileSync(path.join(MIGRATIONS, '0059_remove_custom_skills.sql'), 'utf8'));

      const columns = db.pragma('table_info(connections)') as { name: string }[];
      expect(columns.map((column) => column.name)).not.toContain('kind');
      expect(db.prepare('SELECT name, slug FROM connections').all()).toEqual([
        { name: 'Shopify', slug: 'shopify' },
      ]);
    } finally {
      db.close();
    }
  });
});
