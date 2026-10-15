#!/usr/bin/python3
"""Unlock only the registered Veneer SSD; never create a substitute data root."""
import json
import os
import pathlib
import plistlib
import pwd
import fcntl
import stat
import subprocess
import sys

CONFIG = pathlib.Path(pwd.getpwuid(os.getuid()).pw_dir) / '.config/veneer-pro/external-volume/volume.json'

def info(identifier):
    result = subprocess.run(['/usr/sbin/diskutil', 'info', '-plist', identifier],
                            capture_output=True, timeout=15)
    if result.returncode:
        return None
    return plistlib.loads(result.stdout)

def main():
    config = json.loads(CONFIG.read_text())
    expected = config['volume_uuid']
    disk = info(expected)
    if disk is None:
        print('VeneerData is absent; no replacement directory was created.')
        return 1
    if disk.get('VolumeUUID') != expected or disk.get('Internal'):
        raise RuntimeError('Unexpected disk identity')
    if disk.get('Locked'):
        key_path = pathlib.Path(config['recovery_key_path'])
        metadata = key_path.lstat()
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()
                or stat.S_IMODE(metadata.st_mode) & 0o077):
            raise RuntimeError('Recovery key ownership or permissions are unsafe')
        result = subprocess.run(['/usr/sbin/diskutil', 'apfs', 'unlockVolume',
                                 disk['DeviceIdentifier'], '-user', 'disk',
                                 '-stdinpassphrase'], input=key_path.read_bytes(),
                                capture_output=True, timeout=30)
        if result.returncode:
            raise RuntimeError('Could not unlock the registered volume')
    disk = info(expected)
    if not disk.get('MountPoint'):
        subprocess.run(['/usr/sbin/diskutil', 'mount', disk['DeviceIdentifier']],
                       check=True, capture_output=True, timeout=30)
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
