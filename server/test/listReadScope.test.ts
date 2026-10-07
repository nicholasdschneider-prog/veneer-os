import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { listReadScope } from '../src/bots/listReadScope.js';

it('never retains authorization reads between scopes and invalidates after a write', () => {
  const source = new Database(':memory:');
  try {
    source.exec('CREATE TABLE access (id INTEGER, allowed INTEGER); INSERT INTO access VALUES(1,1)');
    const { db, scope } = listReadScope(source);
    const read = () => db.prepare('SELECT allowed FROM access WHERE id=?').get(1);
    expect(scope(read)).toEqual({ allowed: 1 });
    source.prepare('UPDATE access SET allowed=0').run();
    expect(scope(read)).toEqual({ allowed: 0 });
    scope(() => {
      expect(read()).toEqual({ allowed: 0 });
      db.prepare('UPDATE access SET allowed=1').run();
      expect(read()).toEqual({ allowed: 1 });
    });
    expect(() => scope(() => { read(); throw new Error('failed'); })).toThrow('failed');
    source.prepare('UPDATE access SET allowed=0').run();
    expect(scope(read)).toEqual({ allowed: 0 });
  } finally { source.close(); }
});
