import type Database from 'better-sqlite3';

/** Reuse identical reads only during one synchronous list. Nothing survives a
 * request, so changed membership, evidence or decision state is always fresh.
 * Existing access helpers use this handle too, without duplicating their rules. */
export function listReadScope(source: Database.Database) {
  let reads: Map<string, unknown> | null = null;
  let statements: Map<string, Database.Statement> | null = null;
  const db = new Proxy(source, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => {
        if (!reads) return target.prepare(sql);
        if (!/^\s*SELECT\b/i.test(sql)) {
          const statement = target.prepare(sql);
          return new Proxy(statement, {
            get(stmt, method) {
              const value = Reflect.get(stmt, method, stmt);
              if (typeof value !== 'function') return value;
              return (...args: unknown[]) => { reads?.clear(); return value.apply(stmt, args); };
            },
          });
        }
        let statement = statements!.get(sql);
        if (!statement) { statement = target.prepare(sql); statements!.set(sql, statement); }
        return new Proxy(statement, {
          get(stmt, method) {
            if (method === 'get' || method === 'all') return (...args: unknown[]) => {
              const key = JSON.stringify([sql, method, args]);
              if (!reads!.has(key)) reads!.set(key, stmt[method](...args));
              return reads!.get(key);
            };
            const value = Reflect.get(stmt, method, stmt);
            return typeof value === 'function' ? value.bind(stmt) : value;
          },
        });
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  function scope<T>(read: () => T): T {
    if (reads) return read();
    reads = new Map(); statements = new Map();
    try { return read(); }
    finally { reads = null; statements = null; }
  }
  return { db, scope };
}
