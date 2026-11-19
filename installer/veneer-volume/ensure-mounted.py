#!/usr/bin/python3
"""Unlock only the registered Veneer SSD; never create a substitute data root.

Installed copy: ~/.local/lib/veneer-volume/ensure-mounted.py (the service
plists exec through it). After a reboot the enclosure can take a while to
enumerate and unlock, so one invocation keeps trying for a few minutes instead
of exiting and waiting for launchd's throttled respawn.
"""
import json
import os
import pathlib
import plistlib
import pwd
import fcntl
import stat
import subprocess
import sys
import time

CONFIG = pathlib.Path(pwd.getpwuid(os.getuid()).pw_dir) / '.config/veneer-pro/external-volume/volume.json'
WAIT_SECONDS = int(os.environ.get('VENEER_VOLUME_WAIT_SECONDS', '180'))
RETRY_SECONDS = 5


class Retry(Exception):
    """A condition that may clear on its own: device not there yet, unlock or mount refused."""


def retry_until(step, deadline, pause=RETRY_SECONDS, sleep=time.sleep, clock=time.monotonic, log=None):
    """Run step() until it returns; a Retry is logged and retried until the deadline, then re-raised."""
    attempt = 0
    while True:
        attempt += 1
        try:
            return step()
        except Retry as reason:
            if log:
                log('attempt %d: %s' % (attempt, reason))
            if clock() + pause > deadline:
                raise
            sleep(pause)


def info(identifier):
    try:
        result = subprocess.run(['/usr/sbin/diskutil', 'info', '-plist', identifier],
                                capture_output=True, timeout=15)
    except subprocess.TimeoutExpired:
        return None
    if result.returncode:
        return None
    return plistlib.loads(result.stdout)


def detail(result):
    # diskutil's own words say why; the passphrase only ever travels on stdin.
    text = (result.stderr or result.stdout or b'').decode('utf-8', 'replace').strip()
    return ' '.join(text.split())[:300] or 'exit %d' % result.returncode


def ensure(config):
    expected = config['volume_uuid']
    disk = info(expected)
    if disk is None:
        raise Retry('VeneerData is absent; no replacement directory was created')
    if disk.get('VolumeUUID') != expected or disk.get('Internal'):
        raise RuntimeError('Unexpected disk identity')
    if disk.get('Locked'):
        key_path = pathlib.Path(config['recovery_key_path'])
        metadata = key_path.lstat()
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()
                or stat.S_IMODE(metadata.st_mode) & 0o077):
            raise RuntimeError('Recovery key ownership or permissions are unsafe')
        try:
            result = subprocess.run(['/usr/sbin/diskutil', 'apfs', 'unlockVolume',
                                     disk['DeviceIdentifier'], '-user', 'disk',
                                     '-stdinpassphrase'], input=key_path.read_bytes(),
                                    capture_output=True, timeout=30)
        except subprocess.TimeoutExpired:
            raise Retry('unlock timed out after 30 s')
        if result.returncode:
            raise Retry('could not unlock the registered volume: ' + detail(result))
    disk = info(expected)
    if disk is None:
        raise Retry('volume disappeared after unlock')
    if not disk.get('MountPoint'):
        try:
            result = subprocess.run(['/usr/sbin/diskutil', 'mount', disk['DeviceIdentifier']],
                                    capture_output=True, timeout=30)
        except subprocess.TimeoutExpired:
            raise Retry('mount timed out after 30 s')
        if result.returncode:
            raise Retry('could not mount the registered volume: ' + detail(result))
    disk = info(config['mount_point'])
    if (disk is None or disk.get('VolumeUUID') != expected or
            not disk.get('FileVault') or not disk.get('GlobalPermissionsEnabled') or
            not disk.get('Writable')):
        raise RuntimeError('Volume identity, encryption, ownership or write check failed')
    root = pathlib.Path(config['mount_point']) / 'Veneer'
    if not root.is_dir() or not os.access(root, os.W_OK):
        raise RuntimeError('The existing Veneer directory is not writable')
    staging = config.get('backup_staging_dir')
    if staging:
        stage = pathlib.Path(staging)
        if not stage.is_dir() or not stage.resolve().is_relative_to(root.resolve()):
            raise RuntimeError('Backup staging directory is missing or outside the verified volume')
        os.environ.setdefault('VP_BACKUP_STAGING_DIR', str(stage))
    return 0


def main():
    config = json.loads(CONFIG.read_text())
    log = lambda line: print('VeneerData not ready, ' + line, file=sys.stderr, flush=True)
    retry_until(lambda: ensure(config), time.monotonic() + WAIT_SECONDS, log=log)
    print('Verified encrypted VeneerData volume is mounted and available.')
    return 0


if __name__ == '__main__':
    try:
        with open(CONFIG.with_name('mount.lock'), 'a') as lock:
            os.chmod(CONFIG.with_name('mount.lock'), 0o600)
            fcntl.flock(lock, fcntl.LOCK_EX)
            code = main()
        if code == 0 and len(sys.argv) > 2 and sys.argv[1] == '--exec':
            os.execvpe(sys.argv[2], sys.argv[2:], os.environ)
        sys.exit(code)
    except Exception as error:
        print('VeneerData check failed: ' + str(error), file=sys.stderr)
        sys.exit(1)
