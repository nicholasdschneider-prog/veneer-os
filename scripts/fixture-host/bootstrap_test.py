import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('fixture_host', Path(__file__).with_name('bootstrap.py'))
host = importlib.util.module_from_spec(spec); spec.loader.exec_module(host)


class HostAcceptance(unittest.TestCase):
    def test_actual_bootstrap_controls_denials_and_descendant(self):
        receipt = host.acceptance()
        self.assertTrue(receipt['accepted'])
        self.assertFalse(receipt['nativeFixtureAdmission'])
        self.assertGreater(len(receipt['nodeInventory']), 10)
        self.assertEqual(receipt['results']['active']['exitCode'], 0)
        self.assertEqual(receipt['results']['node']['exitCode'], 0)
        self.assertEqual(receipt['results']['withoutRoot']['exitCode'], -6)
        control = host.observation(receipt['results']['control'])
        active = host.observation(receipt['results']['active'])
        child = host.observation(receipt['results']['descendantDiagnostic'])
        for key in ('deniedReadErrno', 'deniedWriteErrno', 'deniedTcpErrno', 'deniedUnixErrno',
                    'ownSpawnErrno', 'otherSpawnErrno', 'symlinkReadErrno'):
            broken = copy.deepcopy(active); broken[key] = 0
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                host.validate(control, broken, child)
        for key in ('deniedReadErrno', 'deniedTcpErrno', 'deniedUnixErrno'):
            broken = copy.deepcopy(control); broken[key] = 2
            with self.subTest(control=key), self.assertRaises(RuntimeError):
                host.validate(broken, active, child)
        for key, value in [('fd3Closed', False), ('parentMarkerAbsent', False), ('forkResult', 0),
                           ('allowedReadErrno', 1), ('allowedWriteErrno', 1)]:
            broken = copy.deepcopy(active); broken[key] = value
            with self.subTest(boundary=key), self.assertRaises(RuntimeError):
                host.validate(control, broken, child)
        with self.assertRaises(RuntimeError):
            host.validate(control, active, {**child, 'forkResult': -2})

    def test_abort_missing_output_and_ack_never_certify(self):
        for result in ({'exitCode': -6, 'stdout': ''}, {'exitCode': 0, 'stdout': '{}'},
                       {'exitCode': 0, 'stdout': '{"booted":false}'}):
            with self.subTest(result=result), self.assertRaises(RuntimeError):
                host.observation(result)

    def test_unsupported_host_fails_before_any_process(self):
        with patch.object(host.platform, 'system', return_value='Linux'), patch.object(host, 'run') as run:
            with self.assertRaises(RuntimeError):
                host.acceptance()
            run.assert_not_called()

    def test_no_parent_environment_or_descriptor_leak(self):
        with tempfile.TemporaryDirectory() as directory:
            result = host.run(['/usr/bin/env'], Path(directory), host.ENV)
            self.assertEqual(result['exitCode'], 0)
            self.assertEqual(set(result['stdout'].splitlines()), {'PATH=/usr/bin:/bin', 'LANG=C'})

    def test_receipt_cannot_overwrite_prior_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            receipt = Path(directory) / 'receipt.json'; receipt.write_text('previous')
            with patch.object(host, 'acceptance', return_value={'accepted': True}), \
                 patch('sys.argv', ['bootstrap.py', '--receipt', str(receipt)]):
                with self.assertRaises(FileExistsError):
                    host.main()
            self.assertEqual(receipt.read_text(), 'previous')

    def test_profile_has_no_network_fork_or_general_execution_grant(self):
        profile = host.profile(Path('/synthetic/probe'), Path('/synthetic/private'))
        self.assertIn('(deny default)', profile)
        self.assertNotIn('network', profile)
        self.assertNotIn('process-fork', profile)
        self.assertNotIn('(allow process*)', profile)
        self.assertIn('(allow process-exec* (literal "/synthetic/probe"))', profile)
        self.assertNotIn('(subpath "/")', profile)


if __name__ == '__main__':
    unittest.main()
