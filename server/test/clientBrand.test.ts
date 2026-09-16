import { describe, expect, it } from 'vitest';
import { clientDisplayName } from '../src/identity/clientBrand.js';

describe('client branding', () => {
  it('returns the configured fleet client display name', () => {
    expect(clientDisplayName({ VP_CLIENT_NAME: '  Acme  ' })).toBe('Acme');
  });

  it('keeps non-client installs unbranded', () => {
    expect(clientDisplayName({ VP_INSTANCE_NAME: 'Mac Studio' })).toBeNull();
    expect(clientDisplayName({ VP_CLIENT_NAME: '   ' })).toBeNull();
  });
});
