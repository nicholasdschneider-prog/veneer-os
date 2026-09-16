import { describe, expect, it } from 'vitest';
import {
  decideAction,
  globMatches,
  parsePolicy,
  parsePolicySafe,
  policyToPermissions,
  type Policy,
} from '../src/toolbox/policy.js';

describe('glob matching', () => {
  it('matches * as any run including empty, literal otherwise', () => {
    expect(globMatches('mcp__shopify__get_*', 'mcp__shopify__get_orders')).toBe(true);
    expect(globMatches('mcp__shopify__get_*', 'mcp__shopify__get_')).toBe(true);
    expect(globMatches('mcp__shopify__get_*', 'mcp__shopify__set_orders')).toBe(false);
    expect(globMatches('*write*', 'mcp__shopify__update_write_order')).toBe(true);
    expect(globMatches('*', 'anything')).toBe(true);
    expect(globMatches('Bash', 'Bash')).toBe(true);
    expect(globMatches('Bash', 'BashTool')).toBe(false);
  });

  it('treats regex metacharacters literally', () => {
    expect(globMatches('a.b', 'axb')).toBe(false);
    expect(globMatches('a.b', 'a.b')).toBe(true);
  });
});

describe('decideAction (first match wins, then default)', () => {
  const policy: Policy = {
    default: 'deny',
    rules: [
      { match: 'mcp__shopify__get_*', action: 'allow' },
      { match: 'mcp__shopify__*write*', action: 'approve' },
      { match: 'mcp__shopify__*', action: 'deny' },
    ],
  };

  it('returns the first matching rule, not a later one', () => {
    expect(decideAction('mcp__shopify__get_orders', policy)).toBe('allow');
    expect(decideAction('mcp__shopify__update_write', policy)).toBe('approve');
    expect(decideAction('mcp__shopify__delete_order', policy)).toBe('deny');
  });

  it('falls back to default when nothing matches', () => {
    expect(decideAction('mcp__gmail__send', policy)).toBe('deny');
    expect(decideAction('Read', { default: 'approve', rules: [] })).toBe('approve');
  });
});

describe('policyToPermissions', () => {
  it('splits allow/deny rules and drops approve (falls through to control_request)', () => {
    const perms = policyToPermissions({
      default: 'approve',
      rules: [
        { match: 'get_*', action: 'allow' },
        { match: 'send_*', action: 'approve' },
        { match: 'delete_*', action: 'deny' },
      ],
    });
    expect(perms.allow).toEqual(['get_*']);
    expect(perms.deny).toEqual(['delete_*']);
  });

  it('scopes a non-approve default to the connection prefix only', () => {
    expect(policyToPermissions({ default: 'allow', rules: [] }, 'mcp__x__').allow).toEqual(['mcp__x__*']);
    expect(policyToPermissions({ default: 'deny', rules: [] }, 'mcp__x__').deny).toEqual(['mcp__x__*']);
    expect(policyToPermissions({ default: 'approve', rules: [] }, 'mcp__x__')).toEqual({ allow: [], deny: [] });
  });
});

describe('policy parsing', () => {
  it('applies defaults for missing fields', () => {
    expect(parsePolicy({})).toEqual({ default: 'approve', rules: [] });
    expect(parsePolicy('{"default":"deny"}')).toEqual({ default: 'deny', rules: [] });
  });

  it('rejects invalid actions in strict parse but is lenient in safe parse', () => {
    expect(() => parsePolicy({ default: 'nope' })).toThrow();
    expect(parsePolicySafe('{bad json').default).toBe('approve');
    expect(parsePolicySafe({ default: 'bogus' })).toEqual({ default: 'approve', rules: [] });
  });
});
