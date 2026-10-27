import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('guard', Path(__file__).with_name('disk_guard.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


class GuardTests(unittest.TestCase):
    def test_pressure_boundaries(self):
        self.assertEqual(guard.severity(2 * guard.GIB, 0), 'critical')
        self.assertEqual(guard.severity(3 * guard.GIB, 0), 'warning')
        self.assertEqual(guard.severity(10 * guard.GIB, 0), 'healthy')
        self.assertEqual(guard.severity(20 * guard.GIB, 8 * guard.GIB), 'warning')

    def test_backup_reserves_staging_archive_and_growth(self):
        self.assertEqual(guard.backup_required_bytes(0), 20 * guard.GIB)
        self.assertEqual(guard.backup_required_bytes(12 * guard.GIB), 41 * guard.GIB)

    def test_external_staging_reserves_internal_archive_space(self):
        self.assertEqual(guard.backup_required_bytes(12 * guard.GIB, True), 29 * guard.GIB)

    def test_external_archives_reserve_both_volumes(self):
        self.assertEqual(guard.external_archive_requirements(30 * guard.GIB),
                         (65 * guard.GIB, 35 * guard.GIB))

    def test_relocated_transcripts_are_counted(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / 'data').mkdir()
            (root / 'external').mkdir()
            (root / 'external/history').write_bytes(b'abc')
            (root / 'data/transcripts').symlink_to(root / 'external')
            self.assertEqual(guard.logical_size(root / 'data'), 3)

    def test_alert_cooldown_escalation_and_recovery(self):
        old = {'severity': 'warning', 'last_notification_at': 100}
        self.assertFalse(guard.should_notify({'severity': 'warning', 'at': 120}, old))
        self.assertTrue(guard.should_notify({'severity': 'critical', 'at': 120}, old))
        self.assertTrue(guard.should_notify({'severity': 'healthy', 'at': 120}, old))
        self.assertTrue(guard.should_notify({'severity': 'warning', 'at': 1900}, old))

    def test_telemetry_is_bounded_and_preserves_other_files(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            protected = root / 'history.sqlite'
            protected.write_text('preserved')
            history = root / 'samples.jsonl'
            history.write_text('x' * (1024 * 1024))
            guard.persist({'severity': 'warning'}, root / 'status.json', history)
            self.assertLess(history.stat().st_size, 1024)
            self.assertEqual(protected.read_text(), 'preserved')


if __name__ == '__main__':
    unittest.main()
