#!/usr/bin/env python3
"""Read-only disk/swap alerts and a fail-closed nightly-backup preflight.

Never delete data, kill processes, or restart services. Only own telemetry is replaced.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

GIB = 1024 ** 3
ROOT = Path(__file__).resolve().parent
DATA = Path('/Users/archerclawdington/.local/share/veneer-pro')
STATE = ROOT / 'status.json'
HISTORY = ROOT / 'samples.jsonl'


def severity(free, swap):
    if free < 3 * GIB:
        return 'critical'
    if free < 10 * GIB or swap >= 8 * GIB:
        return 'warning'
    return 'healthy'


def backup_required_bytes(source_bytes, external_staging=False):
    # Full staging copy + worst-case archive + concurrent growth headroom.
    return max(20 * GIB, (2 if external_staging else 3) * source_bytes + 5 * GIB)


def external_archive_requirements(source_bytes):
    # External staging + new full archive; internal atomic recovery replacement.
    return (max(20 * GIB, 2 * source_bytes + 5 * GIB),
            max(20 * GIB, source_bytes + 5 * GIB))


def logical_size(root):
    total = 0
    for base, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = [d for d in dirs if not (Path(base) / d).is_symlink()]
        for name in files:
            p = Path(base) / name
            if not p.is_symlink():
                total += p.stat().st_size
    transcripts = Path(root) / "transcripts"
    if transcripts.is_symlink():
        total += logical_size(transcripts.resolve(strict=True))
    return total


def snapshot():
    swap = sum(p.stat().st_blocks * 512 for p in Path('/System/Volumes/VM').glob('swapfile*'))
    free = shutil.disk_usage('/System/Volumes/Data').free
    return {'time_utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'at': time.time(), 'free_bytes': free, 'swap_allocated_bytes': swap,
            'severity': severity(free, swap)}


def should_notify(current, previous):
    rank = {'healthy': 0, 'warning': 1, 'critical': 2}
    if current['severity'] == 'healthy':
        return previous.get('severity', 'healthy') != 'healthy'
    return (rank[current['severity']] > rank.get(previous.get('severity'), 0)
            or current['at'] - previous.get('last_notification_at', 0) >= 1800)


def notification(message):
    # No shell and no secret or source content in the notification.
    script = 'display notification ' + json.dumps(message) + ' with title "Veneer Mac disk pressure"'
    try:
        r = subprocess.run(['/usr/bin/osascript', '-e', script],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        return 'submitted' if r.returncode == 0 else 'failed'
    except (OSError, subprocess.TimeoutExpired):
        return 'failed'


def persist(current, state=STATE, history=HISTORY):
    temp = state.with_suffix('.tmp')
    temp.write_text(json.dumps(current, sort_keys=True) + '\n')
    os.chmod(temp, 0o600)
    temp.replace(state)
    # Bounded telemetry; does not touch any provider logs or history.
    if history.exists() and history.stat().st_size >= 1024 * 1024:
        history.write_text('')
    with history.open('a') as f:
        f.write(json.dumps(current, sort_keys=True) + '\n')
    os.chmod(history, 0o600)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--backup', action='store_true')
    parser.add_argument('--check-only', action='store_true')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    try:
        current = snapshot()
        try:
            previous = json.loads(STATE.read_text())
        except (OSError, ValueError):
            previous = {}
        current['last_notification_at'] = previous.get('last_notification_at', 0)
        if args.backup:
            if not DATA.is_dir():
                raise RuntimeError('Backup source is missing; refusing to run.')
            source_bytes = logical_size(DATA)
            staging = os.environ.get('VP_BACKUP_STAGING_DIR')
            separate = bool(staging and Path(staging).stat().st_dev != DATA.stat().st_dev)
            required = backup_required_bytes(source_bytes, separate)
            staging_blocked = False
            if separate:
                current['staging_required_bytes'] = source_bytes + 5 * GIB
                current['staging_free_bytes'] = shutil.disk_usage(staging).free
                staging_blocked = current['staging_free_bytes'] < current['staging_required_bytes']
            current['backup_required_bytes'] = required
            current['backup_blocked'] = current['free_bytes'] < required or staging_blocked
            archive_dir = Path(os.environ.get('VP_BACKUP_DIR', str(Path.home() / '.local/share/veneer-pro-backups')))
            if archive_dir.is_symlink() and not archive_dir.exists():
                raise RuntimeError('Backup archive volume is unavailable.')
            if archive_dir.exists() and archive_dir.stat().st_dev != DATA.stat().st_dev:
                if not staging or Path(staging).stat().st_dev != archive_dir.stat().st_dev:
                    raise RuntimeError('External archives require staging on the same volume.')
                external_required, internal_required = external_archive_requirements(source_bytes)
                current['archive_free_bytes'] = shutil.disk_usage(archive_dir).free
                current['archive_required_bytes'] = external_required
                current['backup_required_bytes'] = internal_required
                current['backup_blocked'] = (current['free_bytes'] < internal_required
                                             or current['archive_free_bytes'] < external_required)
        message = (f"{current['free_bytes']/GIB:.1f} GiB free; "
                   f"{current['swap_allocated_bytes']/GIB:.1f} GiB swap. "
                   'Check the disk-pressure status in the ERVP project.')
        if current.get('backup_blocked'):
            message += ' Nightly backup skipped for insufficient staging space; existing backups kept.'
        if not args.check_only:
            if should_notify(current, previous) or current.get('backup_blocked'):
                current['notification_submission'] = notification(message)
                if current['notification_submission'] == 'submitted':
                    current['last_notification_at'] = current['at']
            persist(current)
        print(json.dumps(current, sort_keys=True))
        if args.backup:
            if current.get('backup_blocked'):
                return 75
            command = args.command
            if command and command[0] == '--':
                command = command[1:]
            expected = ['/opt/homebrew/opt/node@24/bin/node',
                        '/Users/archerclawdington/veneer-os/installer/backup.mjs']
            if command != expected:
                raise RuntimeError('Unexpected backup command; refusing to run.')
            if args.check_only:
                return 0
            os.execv(command[0], command)
        return 0
    except Exception as exc:
        print('Disk guard failed: ' + type(exc).__name__, file=sys.stderr)
        # Failed measurement must never authorize a large backup.
        return 75 if args.backup else 1


if __name__ == '__main__':
    sys.exit(main())
