import hashlib
import json
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest
import sys
from datetime import datetime, timezone
from unittest.mock import patch
import bootstrap as boundary
import codex
import peer


class CodexBoundary(unittest.TestCase):
    observations = []
    def test_actual_native_configuration_and_scope_denials(self):
        with tempfile.TemporaryDirectory(dir='/private/tmp') as temporary:
            root = Path(temporary).resolve() / 'native'
            receipt = codex.preflight(root)
            self.observations.append({'kind': 'real_native_preauth', 'receipt': receipt})
            self.assertFalse(receipt['nativeAdmission'])
            self.assertEqual(receipt['hosts']['worker']['credentialStore'], 'ephemeral')
            self.assertEqual(receipt['hosts']['dedicated-auth']['credentialStore'], 'ephemeral')
            worker = root / 'worker'
            secret = root / 'dedicated-auth' / 'codex' / 'auth.json'
            secret.write_text('SYNTHETIC-NOT-A-CREDENTIAL')
            other = root / 'other-session'; other.mkdir(); (other / 'customer').write_text('synthetic')
            fixture = worker / 'fixture'; fixture.write_text('synthetic')
            escape = worker / 'escape'; escape.symlink_to(secret)
            executable = worker / 'probe'
            compiled = boundary.run(['/usr/bin/clang','-Wall','-Wextra','-Werror','-o',str(executable),
                                     str(boundary.SOURCE / 'probe.c')],worker)
            self.assertEqual(compiled['exitCode'],0)
            with socket.socket() as tcp, socket.socket(socket.AF_UNIX) as unix:
                tcp.bind(('127.0.0.1',0)); tcp.listen(10)
                unix_path = root / 'synthetic.sock'; unix.bind(str(unix_path)); unix.listen(10)
                args = [str(executable),str(fixture),str(secret),str(root / 'outside-write'),
                        str(tcp.getsockname()[1]),str(unix_path),str(worker / 'allowed-write'),str(escape)]
                policy = codex.host_profile(worker,executable)
                control = boundary.observation(boundary.run(args,worker,codex.environment(worker)))
                observed = boundary.observation(boundary.run(['/usr/bin/sandbox-exec','-p',policy,*args],
                                                              worker,codex.environment(worker)))
                for name in ['deniedReadErrno','deniedWriteErrno','deniedTcpErrno','deniedUnixErrno',
                             'ownSpawnErrno','otherSpawnErrno','symlinkReadErrno']:
                    self.assertEqual(control[name],0,name)
                    self.assertEqual(observed[name],1,name)
                self.assertEqual(observed['forkResult'],1)
                self.assertTrue(observed['fd3Closed'])
                self.assertTrue(observed['parentMarkerAbsent'])
                descendant = boundary.observation(boundary.run(['/usr/bin/sandbox-exec','-p',
                    policy+'(allow process-fork)',*args],worker,codex.environment(worker)))
                self.assertEqual(descendant['forkResult'],-1)
                cross_args = [*args]; cross_args[2] = str(other / 'customer')
                cross = boundary.observation(boundary.run(['/usr/bin/sandbox-exec','-p',policy,*cross_args],
                                                           worker,codex.environment(worker)))
                self.assertEqual(cross['deniedReadErrno'],1)
                own_cache = worker / 'codex' / 'auth.json'
                own_cache.write_text('SYNTHETIC-NOT-A-CREDENTIAL')
                own_args = [*args]; own_args[2] = str(own_cache); own_args[3] = str(own_cache)
                own = boundary.observation(boundary.run(['/usr/bin/sandbox-exec','-p',policy,*own_args],
                                                         worker,codex.environment(worker)))
                self.assertEqual(own['deniedReadErrno'],1)
                self.assertEqual(own['deniedWriteErrno'],1)
                own_cache.unlink()
                self.observations.append({'kind':'same_policy_synthetic_denials',
                    'control':control,'active':observed,'descendantDiagnostic':descendant,'crossSession':cross,
                    'ownCredentialFileDenied':own})
            client = codex.PreauthClient(worker,root / 'worker.sb')
            try:
                for method in ['thread/start','turn/start','account/login/start','command/exec',
                               'fs/readFile','mcpServer/tool/call','externalAgentConfig/import']:
                    with self.subTest(method=method), self.assertRaisesRegex(RuntimeError,'METHOD_DENIED'):
                        client.send(method,{})
                with self.assertRaisesRegex(RuntimeError,'AUTH_REFRESH_DENIED'):
                    client.send('account/read',{'refreshToken':True})
            finally:
                client.close()

    def test_cli_and_resource_drift_stop_before_native_spawn(self):
        with patch.object(boundary,'digest',return_value='bad'), patch.object(boundary,'run') as run:
            with self.assertRaisesRegex(RuntimeError,'EXECUTABLE_DRIFT'):
                codex.inventory()
            run.assert_not_called()
        with patch.object(boundary,'digest',return_value=codex.BINARY_HASH), \
             patch.object(boundary,'run',return_value={'exitCode':0,'stdout':'binary:\n /outside/library (version)' }):
            with self.assertRaisesRegex(RuntimeError,'RESOURCE_DRIFT'):
                codex.inventory()

    def test_peer_positive_capability_and_scope_denial_registry(self):
        with tempfile.TemporaryDirectory(dir='/private/tmp') as temporary:
            work = Path(temporary).resolve() / 'peer'
            receipt = peer.materialize(work)
            scope = {'runId':'fixture-run','sessionId':'fixture-session','customerId':'fixture-customer','orderId':'fixture-order'}
            capability = 'synthetic-internal-test-capability'
            bind = {'kind':'bind','scope':scope,'capabilityHash':hashlib.sha256(capability.encode()).hexdigest(),
                    'trainingHash':'a'*64}
            def invoke(request):
                raw = json.dumps(bind)+'\n'+json.dumps(request)+'\n'
                result = subprocess.run(['/usr/bin/python3',str(boundary.SOURCE/'peer.py'),'--state',str(work)],
                    input=raw,env=boundary.ENV,cwd=work,capture_output=True,text=True,timeout=10,close_fds=True)
                self.assertEqual(result.returncode,0)
                responses = [json.loads(line) for line in result.stdout.splitlines()]
                self.assertEqual(responses[0],{'result':{'bound':True}})
                self.assertNotIn(capability,result.stdout)
                return responses[1]
            call = {'scope':scope,'capability':capability,'tool':'fixture.preference.set','arguments':{'preference':'morning'}}
            self.assertEqual(invoke(call)['result']['preference'],'morning')
            self.observations.append({'kind':'synthetic_peer_roundtrip', 'profileSha256':receipt['profileSha256'],
                'positivePreference':'morning', 'capabilityLogged':False, 'nativeModelToolRoundtrip':False})
            self.assertEqual(invoke({**call,'capability':'wrong'})['error'],'FIXTURE_CAPABILITY_DENIED')
            for field in scope:
                self.assertEqual(invoke({**call,'scope':{**scope,field:scope[field]+'-other'}})['error'],
                                 'FIXTURE_CAPABILITY_DENIED')
            for tool in ['shell','browser','doppler','business.refund','filesystem.read','network.fetch']:
                self.assertEqual(invoke({**call,'tool':tool})['error'],'FIXTURE_TOOL_DENIED')
            self.assertEqual(invoke({**call,'arguments':{'url':'https://example.invalid'}})['error'],'FIXTURE_ARGUMENTS_DENIED')
            (work/'peer.sb').write_text('(version 1)(allow default)')
            result = subprocess.run(['/usr/bin/python3',str(boundary.SOURCE/'peer.py'),'--state',str(work)],
                input='',env=boundary.ENV,capture_output=True,text=True,timeout=10)
            self.assertNotEqual(result.returncode,0)
            self.assertIn('FIXTURE_PEER_MATERIAL_DRIFT',result.stdout)

    def test_private_credential_home_not_keyring_or_shared_worker_home(self):
        self.assertNotIn('keyring',' '.join(codex.BASE_ARGS))
        self.assertNotIn('network',codex.host_profile(Path('/synthetic/private')))
        self.assertNotIn('process-fork',codex.host_profile(Path('/synthetic/private')))

    def test_same_uid_kernel_environment_control_and_hardened_denial(self):
        with tempfile.TemporaryDirectory(dir='/private/tmp') as temporary:
            work = Path(temporary).resolve()
            executable = work/'process-env-probe'
            compile_result = boundary.run(['/usr/bin/clang','-Wall','-Wextra','-Werror','-o',str(executable),
                str(boundary.SOURCE/'process-env-probe.c')],work)
            self.assertEqual(compile_result['exitCode'],0)
            parent = subprocess.Popen([str(executable)],stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,env={**boundary.ENV,'FIXTURE_PARENT_CANARY':'synthetic'},close_fds=True)
            try:
                observations = []
                hardened = codex.host_profile(work,executable)
                broad = hardened.replace('(allow process-info* (target self))', '').replace(
                    '(deny process-info* (target others))', '')
                start = broad.index('(allow sysctl-read'); end = broad.index('\n',start)
                broad = broad[:start] + '(allow sysctl-read)' + broad[end:]
                for index, policy in enumerate([None,broad,hardened]):
                    args = [str(executable),str(parent.pid)]
                    if policy: args = ['/usr/bin/sandbox-exec','-p',policy,*args]
                    result = boundary.run(args,work,boundary.ENV)
                    self.assertEqual(result['exitCode'],0)
                    observed = json.loads(result['stdout'])
                    self.assertEqual(observed,{'errno':1 if index == 2 else 0,
                                              'syntheticMarkerObserved':index != 2})
                    observations.append(observed)
                self.observations.append({'kind':'same_uid_kernel_environment_control_and_hardened_denial',
                    'observedEnvironmentDenial':True,'syntheticOnly':True,'observations':observations,
                    'fullProtectedNativeAuthBridgeAccepted':False})
            finally:
                parent.stdin.close();parent.wait(timeout=3)


if __name__ == '__main__':
    destination = None
    if '--receipt' in sys.argv:
        position = sys.argv.index('--receipt'); destination = Path(sys.argv[position + 1])
        del sys.argv[position:position + 2]
    tests = unittest.main(exit=False)
    if not tests.result.wasSuccessful():
        raise SystemExit(1)
    if destination:
        with destination.open('x') as output:
            json.dump({'schema':'veneer-codex-preauth-acceptance/v1','acceptedPreauthOnly':True,
                'protectedCredentialBoundaryReady':False,
                'observedAt':datetime.now(timezone.utc).isoformat(),'nativeAdmission':False,
                'actualSignIn':False,'modelStart':False,'nativeReplyMs':None,'carrierDeliveryMs':None,
                'sourceSha256':{'codex.py':boundary.digest(boundary.SOURCE/'codex.py'),
                                'peer.py':boundary.digest(boundary.SOURCE/'peer.py'),
                                'peer.cjs':boundary.digest(boundary.SOURCE/'peer.cjs'),
                                'codex_test.py':boundary.digest(__file__)},
                'observations':CodexBoundary.observations}, output, indent=2)
            output.write('\n')
