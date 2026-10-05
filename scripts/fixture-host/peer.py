#!/usr/bin/env python3
"""Prepare or launch the fixed synthetic stdio peer. No arbitrary command/profile."""
import argparse
import json
import os
from pathlib import Path
import resource
import stat
import bootstrap as boundary


def materialize(work):
    if not work.is_absolute() or work.parent.resolve(strict=True) != work.parent:
        raise RuntimeError('FIXTURE_PRIVATE_PARENT_REQUIRED')
    os.umask(0o077)
    work.mkdir(mode=0o700)
    work = work.resolve(strict=True)
    for directory in ['home', 'tmp']:
        (work / directory).mkdir(mode=0o700)
    (work / 'openssl.cnf').write_text('')
    (work / 'peer.cjs').write_bytes((boundary.SOURCE / 'peer.cjs').read_bytes())
    node, reads, inventory = boundary.node_resources()
    policy = boundary.profile(node, work, reads) + '(allow file-read-metadata ' + ''.join(
        '(literal ' + boundary.quote(p) + ')' for p in work.parents) + ')\n'
    (work / 'peer.sb').write_text(policy)
    manifest = {'schema': 'veneer-fixture-peer-host/v1', 'node': str(node),
                'inventory': inventory, 'sourceSha256': boundary.digest(boundary.SOURCE / 'peer.cjs'),
                'profileSha256': boundary.hashlib.sha256(policy.encode()).hexdigest()}
    (work / 'host.json').write_text(json.dumps(manifest))
    return manifest


def launch(work):
    if work.is_symlink() or work.resolve() != work or work.stat().st_mode & 0o077:
        raise RuntimeError('FIXTURE_PRIVATE_HOST_REQUIRED')
    for name in ['host.json', 'peer.cjs', 'peer.sb', 'openssl.cnf']:
        metadata = (work / name).lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or metadata.st_mode & 0o077:
            raise RuntimeError('FIXTURE_PEER_MATERIAL_DRIFT')
    saved = json.loads((work / 'host.json').read_text())
    node, reads, inventory = boundary.node_resources()
    expected = boundary.profile(node, work, reads) + '(allow file-read-metadata ' + ''.join(
        '(literal ' + boundary.quote(p) + ')' for p in work.parents) + ')\n'
    if (saved['inventory'] != inventory or saved['node'] != str(node) or
        saved['sourceSha256'] != boundary.digest(boundary.SOURCE / 'peer.cjs') or
        boundary.digest(work / 'peer.cjs') != saved['sourceSha256'] or
        (work / 'peer.sb').read_text() != expected or
        saved['profileSha256'] != boundary.hashlib.sha256(expected.encode()).hexdigest()):
        raise RuntimeError('FIXTURE_PEER_MATERIAL_DRIFT')
    env = {**boundary.ENV, 'HOME': str(work / 'home'), 'TMPDIR': str(work / 'tmp'),
           'OPENSSL_CONF': str(work / 'openssl.cnf')}
    boundary.limits()
    # Parent explicitly supplies only stdio; CLOEXEC and close_fds are enforced there.
    os.execve('/usr/bin/sandbox-exec', ['/usr/bin/sandbox-exec', '-f', str(work / 'peer.sb'),
                                      str(node), str(work / 'peer.cjs')], env)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', type=Path, required=True)
    parser.add_argument('--prepare', action='store_true')
    args = parser.parse_args()
    try:
        if args.prepare:
            print(json.dumps(materialize(args.state)))
        else:
            launch(args.state)
    except Exception as error:
        code = str(error)
        if not code.startswith('FIXTURE_'): code = 'FIXTURE_PEER_UNAVAILABLE'
        print(json.dumps({'error': code}))
        raise SystemExit(1)


if __name__ == '__main__':
    main()
