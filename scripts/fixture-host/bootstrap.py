#!/usr/bin/env python3
"""Fixed harmless Seatbelt acceptance launcher. No provider/auth/command inputs."""
import argparse
from datetime import datetime, timezone
import errno
import hashlib
import json
import os
from pathlib import Path
import platform
import resource
import socket
import subprocess
import tempfile
import time

SOURCE = Path(__file__).resolve().parent
ENV = {"PATH": "/usr/bin:/bin", "LANG": "C"}
LIMIT = 16384
NODE = Path('/opt/homebrew/opt/node@24/bin/node')


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def quote(path):
    # SBPL quoted string; paths are internally generated, never interpolated raw.
    return json.dumps(str(path))


def profile(binary, workspace, resources=(), root=True, descendants=False):
    reads = [binary, *resources]
    rules = [
        '(version 1)', '(deny default)',
        '(allow sysctl-read)',
        '(allow file-read* (subpath "/System") (subpath "/usr/lib")'
        + (' (literal "/")' if root else '')
        + ''.join(' (literal ' + quote(p) + ')' for p in reads)
        + ' (subpath ' + quote(workspace) + '))',
        '(allow file-write* (subpath ' + quote(workspace) + '))',
        '(allow process-exec* (literal ' + quote(binary) + '))',
    ]
    if descendants:
        rules.append('(allow process-fork)')
    return '\n'.join(rules) + '\n'


def run(command, cwd, env=None, control_fd=None):
    started = time.monotonic_ns()
    # Fixed harmless commands only. A dedicated session permits bounded cleanup.
    def prepare():
        limits()
        if control_fd is not None:
            os.dup2(control_fd, 3, inheritable=True)

    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        child = subprocess.Popen(command, cwd=cwd, env=env or ENV,
                                 stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                                 close_fds=True, pass_fds=(() if control_fd is None else tuple(sorted({3, control_fd}))),
                                 start_new_session=True, preexec_fn=prepare)
        try:
            code = child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            import signal
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
            raise RuntimeError('Harmless bootstrap timed out; no acceptance')
        out.seek(0); err.seek(0)
        stdout = out.read(LIMIT + 1); stderr = err.read(LIMIT + 1)
        if len(stdout) > LIMIT or len(stderr) > LIMIT:
            raise RuntimeError('Output budget exceeded; no acceptance')
    return {"exitCode": code, "elapsedNs": time.monotonic_ns() - started,
            "stdout": stdout.decode(errors="replace"), "stderr": stderr.decode(errors="replace")}


def limits():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_CPU, (8, 8))
    resource.setrlimit(resource.RLIMIT_FSIZE, (1024 * 1024, 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))


def node_resources():
    """Inventory public linked code only; unknown dependency forms fail closed."""
    node = NODE.resolve(strict=True)
    paths, seen, pending = set(), set(), [node]
    while pending:
        binary = pending.pop()
        if binary in seen:
            continue
        seen.add(binary)
        result = run(['/usr/bin/otool', '-L', str(binary)], SOURCE)
        if result['exitCode'] != 0:
            raise RuntimeError('Cannot inventory linked runtime')
        for line in result['stdout'].splitlines()[1:]:
            dep = line.strip().split(' (')[0]
            if dep.startswith(('/usr/lib/', '/System/')):
                continue
            if dep.startswith('/opt/homebrew/'):
                path = Path(dep)
            elif dep.startswith('@loader_path/'):
                path = binary.parent / dep[len('@loader_path/'):]
            elif dep.startswith('@rpath/'):
                suffix = dep[len('@rpath/'):]
                candidates = [binary.parent / suffix, node.parent / suffix,
                              node.parent.parent / 'lib' / suffix]
                path = next((p for p in candidates if p.is_file()), None)
                if path is None:
                    raise RuntimeError('Unresolved runtime dependency')
            else:
                raise RuntimeError('Unsupported runtime dependency')
            real = path.resolve(strict=True)
            if not str(real).startswith('/opt/homebrew/Cellar/'):
                raise RuntimeError('Runtime dependency outside public Cellar')
            paths.update([path, path.parent.resolve() / path.name, real])
            pending.append(real)
    reads = set(paths)
    for path in paths:
        reads.update(path.parents)
    return node, sorted(reads), {str(p): digest(p) for p in sorted(seen)}


def observation(result):
    if result["exitCode"] != 0:
        raise RuntimeError('Bootstrap did not exit successfully; no enforcement acceptance')
    value = json.loads(result["stdout"])
    if value.get("booted") is not True:
        raise RuntimeError('Missing actual bootstrap observation')
    return value


def validate(control, active, descendant):
    denied = ['deniedReadErrno', 'deniedWriteErrno', 'deniedTcpErrno',
              'deniedUnixErrno', 'ownSpawnErrno', 'otherSpawnErrno', 'symlinkReadErrno']
    for key in denied:
        if control[key] != 0 or active[key] != errno.EPERM:
            raise RuntimeError('Missing positive control or denial: ' + key)
    if active['forkResult'] != errno.EPERM or descendant['forkResult'] != -1:
        raise RuntimeError('Missing fork denial or descendant inheritance')
    if active['allowedReadErrno'] != 0 or active['allowedWriteErrno'] != 0:
        raise RuntimeError('Permitted fixture access did not work')
    if not active['fd3Closed'] or not active['parentMarkerAbsent']:
        raise RuntimeError('Inherited descriptor/environment boundary failed')
    if control['fd3Closed'] or control['parentMarkerAbsent']:
        raise RuntimeError('Missing descriptor/environment positive controls')


def acceptance():
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise RuntimeError('Requires macOS arm64; unsupported hosts cannot certify')
    started_at = datetime.now(timezone.utc).isoformat()
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix='veneer-fixture-', dir='/private/tmp') as temporary:
        root = Path(temporary).resolve()
        work = root / 'private'; work.mkdir(mode=0o700)
        home = work / 'home'; home.mkdir(mode=0o700)
        tmp = work / 'tmp'; tmp.mkdir(mode=0o700)
        env = {**ENV, 'HOME': str(home), 'TMPDIR': str(tmp)}
        canary = root / 'synthetic-secret'; canary.write_text('SYNTHETIC-NOT-A-CREDENTIAL')
        fixture = work / 'fixture'; fixture.write_text('SYNTHETIC')
        escape = work / 'escape'; escape.symlink_to(canary)
        binary = work / 'probe'
        compile_result = run(['/usr/bin/clang', '-Wall', '-Wextra', '-Werror', '-o',
                              str(binary), str(SOURCE / 'probe.c')], work)
        if compile_result['exitCode'] != 0:
            raise RuntimeError('Harmless probe compilation failed')
        unix_path = root / 'synthetic.sock'
        with socket.socket() as tcp, socket.socket(socket.AF_UNIX) as unix:
            tcp.bind(('127.0.0.1', 0)); tcp.listen(16)
            unix.bind(str(unix_path)); unix.listen(16)
            args = [str(binary), str(fixture), str(canary), str(root / 'outside-write'),
                    str(tcp.getsockname()[1]), str(unix_path), str(work / 'write'), str(escape)]
            # Explicit fd3 synthetic control. The staged launcher never passes it.
            fd = os.open(canary, os.O_RDONLY)
            try:
                control_result = run(args, work, {**env, 'FIXTURE_PARENT_CANARY': 'synthetic'}, fd)
            finally:
                os.close(fd)
            outside = root / 'outside-write'
            outside.unlink()
            active_profile = profile(binary, work)
            profiles = {'active': active_profile, 'withoutRoot': profile(binary, work, root=False),
                        'descendantDiagnostic': profile(binary, work, descendants=True)}
            results = {'control': control_result}
            for name, text in profiles.items():
                profile_path = root / (name + '.sb'); profile_path.write_text(text)
                results[name] = run(['/usr/bin/sandbox-exec', '-f', str(profile_path), *args], work, env)
            node, reads, inventory = node_resources()
            script = work / 'node-probe.cjs'
            script.write_bytes((SOURCE / 'node-probe.cjs').read_bytes())
            ssl_config = work / 'openssl.cnf'; ssl_config.write_text('')
            node_profile = profile(node, work, reads)
            node_profile += '(allow file-read-metadata ' + ''.join(
                '(literal ' + quote(p) + ')' for p in work.parents) + ')\n'
            profiles['node'] = node_profile
            node_profile_path = root / 'node.sb'; node_profile_path.write_text(node_profile)
            results['node'] = run(['/usr/bin/sandbox-exec', '-f', str(node_profile_path),
                                   str(node), str(script), *args[1:]], work,
                                  {**env, 'OPENSSL_CONF': str(ssl_config)})
            node_observed = observation(results['node'])
            for key in ['deniedRead', 'deniedWrite', 'deniedSymlink', 'deniedSelfSpawn',
                        'deniedShellSpawn', 'deniedTcp', 'deniedUnix']:
                if node_observed[key] != 'EPERM':
                    raise RuntimeError('Missing Node denial: ' + key)
            if (node_observed['allowedRead'] is not None or node_observed['allowedWrite'] is not None
                    or not node_observed['parentMarkerAbsent']):
                raise RuntimeError('Node private environment/access failed')
            control = observation(results['control'])
            active = observation(results['active'])
            descendant = observation(results['descendantDiagnostic'])
            validate(control, active, descendant)
            if outside.exists() or canary.read_text() != 'SYNTHETIC-NOT-A-CREDENTIAL':
                raise RuntimeError('Synthetic outside mutation occurred')
            return {'schema': 'veneer-harmless-host-acceptance/v1', 'accepted': True,
                    'startedAt': started_at, 'finishedAt': datetime.now(timezone.utc).isoformat(),
                    'host': {'system': platform.system(), 'release': platform.release(), 'arch': platform.machine()},
                    'runtime': 'compiled harmless C and Node 24 probes; no provider or model',
                    'nativeFixtureAdmission': False,
                    'sha256': {'probeSource': digest(SOURCE / 'probe.c'),
                               'launcher': digest(__file__), 'executable': digest(binary)},
                    'nodeInventory': inventory,
                    'nodeProbeSha256': digest(SOURCE / 'node-probe.cjs'),
                    'profiles': profiles,
                    'profileSha256': {name: hashlib.sha256(text.encode()).hexdigest()
                                      for name, text in profiles.items()},
                    'results': results,
                    'scope': 'Local synthetic resources only; descendant profile is diagnostic, never admission',
                    'auth': 'No credentials read or sign-in performed'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    receipt = acceptance()  # Failure never writes accepted evidence.
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive create prevents overwriting an existing receipt.
    with args.receipt.open('x') as output:
        json.dump(receipt, output, indent=2); output.write('\n')
    print(json.dumps({'accepted': True, 'receipt': str(args.receipt)}))


if __name__ == '__main__':
    main()
