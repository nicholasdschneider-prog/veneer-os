import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';

describe('protected native fixture synthetic egress', () => {
  it('proves TLS identity, exact routes/wires, scoped one-attempt UNKNOWN and actual kernel socket denial', () => {
    const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fixture-egress-')));
    const receipt = path.join(temp,'receipt.json');
    try {
      const source = fileURLToPath(new URL('../../scripts/fixture-host/egress_test.py',import.meta.url));
      execFileSync('/usr/bin/python3',[source,'--receipt',receipt],{
        env:{PATH:'/usr/bin:/bin',LANG:'C'},stdio:['ignore','pipe','pipe'],timeout:35_000});
      const evidence = JSON.parse(fs.readFileSync(receipt,'utf8'));
      expect(evidence.passed).toBe(true); expect(evidence.tests).toBe(4);
      expect(evidence.nativeAuthAccepted).toBe(false); expect(evidence.nativeInferenceAccepted).toBe(false);
      expect(evidence.realSignInStarted).toBe(false); expect(evidence.productionInstalled).toBe(false);
      expect(evidence.observations.filter((o: any) => o.kind==='synthetic_tls_route')).toHaveLength(4);
      expect(evidence.observations.find((o: any) => o.kind==='kernel_exact_socket').active)
        .toEqual({allowedTcp:0,alternateTcp:1,alternateUdp:1});
      expect(evidence.observations.find((o: any) => o.kind==='native_proxy_environment_preauth').authCompatible).toBeNull();
      expect(evidence.observations.filter((o: any) => o.kind==='synthetic_failure').map((o: any) => o.receipt.outcome))
        .toEqual(['UNKNOWN','REJECTED','UNKNOWN']);
      expect(JSON.stringify(evidence)).not.toContain('synthetic-forged');
    } finally { fs.rmSync(temp,{recursive:true,force:true}); }
  },40_000);
});
