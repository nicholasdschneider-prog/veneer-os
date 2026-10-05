#!/usr/bin/env python3
"""Fixed pinned Codex app-server pre-auth host. No thread, model or login starts."""
import argparse
from datetime import datetime, timezone
import json
import os
import resource
from pathlib import Path
import selectors
import signal
import subprocess
import time
import bootstrap as boundary

BINARY = Path('/Users/archerclawdington/.local/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex')
BINARY_HASH = '1da3f4e0e96028b8a771814293c3033dafd1971f943f6c7e79b0897fe705f590'
VERSION = 'codex-cli 0.145.0'
BASE_ARGS = ['app-server', '--listen', 'stdio://', '--strict-config',
             '-c', 'features.remote_control=false', '-c', 'features.code_mode_host=false',
             '-c', 'features.tool_search_always_defer_mcp_tools=false',
             '-c', 'approval_policy="never"', '-c', 'sandbox_mode="read-only"',
             '-c', 'web_search="disabled"', '-c', 'analytics.enabled=false',
             '-c', 'shell_environment_policy.inherit="none"']
REQUIREMENTS_METADATA = [Path('/etc'), Path('/private/etc'), Path('/etc/codex'),
                         Path('/private/etc/codex'), Path('/etc/codex/requirements.toml'),
                         Path('/private/etc/codex/requirements.toml')]


def codex_limits():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_CPU, (8, 8))
    # Native startup creates its private SQLite/WAL state; 1 MiB kills bootstrap.
    resource.setrlimit(resource.RLIMIT_FSIZE, (32 * 1024 * 1024, 32 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))


def inventory():
    if boundary.digest(BINARY) != BINARY_HASH:
        raise RuntimeError('CODEX_EXECUTABLE_DRIFT')
    result = boundary.run(['/usr/bin/otool', '-L', str(BINARY)], boundary.SOURCE)
    if result['exitCode'] != 0:
        raise RuntimeError('CODEX_RESOURCE_INVENTORY_UNAVAILABLE')
    resources = [line.strip().split(' (')[0] for line in result['stdout'].splitlines()[1:]]
    if not resources or any(not p.startswith(('/System/', '/usr/lib/')) for p in resources):
        raise RuntimeError('CODEX_RESOURCE_DRIFT')
    return resources


def host_profile(work, executable=BINARY):
    # Reuse the verified boundary. Metadata resolves absent global requirements;
    # existing unreadable requirements are NOT opened or ignored as acceptance.
    return boundary.profile(executable, work) + '(allow file-read-metadata ' + ''.join(
        '(literal ' + boundary.quote(p) + ')' for p in [*work.parents, *REQUIREMENTS_METADATA]) + ')\n'


def environment(work):
    return {**boundary.ENV, 'HOME': str(work / 'home'), 'CODEX_HOME': str(work / 'codex'),
            'TMPDIR': str(work / 'tmp')}


def process_environment_boundary(root):
    work = root / 'process-boundary'; work.mkdir(mode=0o700)
    executable = work / 'probe'
    result = boundary.run(['/usr/bin/clang', '-Wall', '-Wextra', '-Werror', '-o', str(executable),
                           str(boundary.SOURCE / 'process-env-probe.c')], work)
    if result['exitCode'] != 0: raise RuntimeError('CODEX_ENV_PROBE_UNAVAILABLE')
    parent = subprocess.Popen([str(executable)], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, env={**boundary.ENV, 'FIXTURE_PARENT_CANARY': 'synthetic'}, close_fds=True)
    try:
        args = [str(executable), str(parent.pid)]
        control = boundary.run(args, work, boundary.ENV)
        active = boundary.run(['/usr/bin/sandbox-exec', '-p', host_profile(work, executable), *args],work,boundary.ENV)
        if (control['exitCode'] != 0 or active['exitCode'] != 0 or
            json.loads(control['stdout']) != {'errno':0,'syntheticMarkerObserved':True} or
            json.loads(active['stdout']) != {'errno':1,'syntheticMarkerObserved':False}):
            raise RuntimeError('CODEX_PID_CREDENTIAL_BOUNDARY_UNACCEPTED')
        return {'sourceSha256':boundary.digest(boundary.SOURCE/'process-env-probe.c'),
                'control':control,'active':active,'syntheticOnly':True,'observedDenial':True}
    finally:
        parent.stdin.close(); parent.wait(timeout=3)


class PreauthClient:
    """Only bootstrap/account/config methods; no user-supplied native RPC."""
    METHODS = {'initialize', 'account/read', 'config/read'}
    def __init__(self, work, profile_path, auth=False):
        self.work = work
        self.events = []
        self.sequence = 0
        self.buffers = {}
        self.bytes = 0
        self.child = subprocess.Popen(
            ['/usr/bin/sandbox-exec', '-f', str(profile_path), str(BINARY), *BASE_ARGS,
             '-c', 'cli_auth_credentials_store="' + ('file' if auth else 'ephemeral') + '"'],
            cwd=work, env=environment(work), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, close_fds=True, start_new_session=True, preexec_fn=codex_limits)
        self.selector = selectors.DefaultSelector()
        for stream, kind in [(self.child.stdout, 'stdout'), (self.child.stderr, 'stderr')]:
            os.set_blocking(stream.fileno(), False)
            self.selector.register(stream, selectors.EVENT_READ, kind)
            self.buffers[kind] = b''
        self.event('process_spawned')

    def event(self, kind, **fields):
        self.events.append({'kind': kind, 'monotonicNs': time.monotonic_ns(), **fields})

    def send(self, method, params):
        if method not in self.METHODS:
            raise RuntimeError('CODEX_PREAUTH_METHOD_DENIED')
        if method == 'account/read' and params != {'refreshToken': False}:
            raise RuntimeError('CODEX_AUTH_REFRESH_DENIED')
        self.sequence += 1
        request = {'id': self.sequence, 'method': method, 'params': params}
        self.child.stdin.write((json.dumps(request) + '\n').encode()); self.child.stdin.flush()
        self.event('rpc_sent', method=method, requestId=self.sequence)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            for key, _ in self.selector.select(max(0, deadline - time.monotonic())):
                data = os.read(key.fd, 4096)
                if not data:
                    self.selector.unregister(key.fileobj)
                    continue
                self.bytes += len(data)
                if self.bytes > boundary.LIMIT:
                    raise RuntimeError('CODEX_OUTPUT_BUDGET')
                kind = key.data
                self.buffers[kind] += data
                while b'\n' in self.buffers[kind]:
                    line, self.buffers[kind] = self.buffers[kind].split(b'\n', 1)
                    if kind == 'stderr':
                        # No raw stderr persisted or returned; no potential secret log.
                        if b'ERROR' in line or b'Invalid configuration' in line:
                            raise RuntimeError('CODEX_CONFIGURATION_UNACCEPTED')
                        continue
                    try:
                        message = json.loads(line)
                    except ValueError:
                        raise RuntimeError('CODEX_PROTOCOL_INVALID')
                    if message.get('method') == 'configWarning':
                        raise RuntimeError('CODEX_CONFIGURATION_UNACCEPTED')
                    if 'method' in message and 'id' in message:
                        # Any server tool/approval request is declined; no handler fallback.
                        self.child.stdin.write((json.dumps({'id': message['id'], 'error': {
                            'code': -32601, 'message': 'Fixture pre-auth boundary denies all tool requests'}}) + '\n').encode())
                        self.child.stdin.flush()
                        self.event('server_request_denied')
                    if message.get('id') == self.sequence and 'method' not in message:
                        if 'error' in message:
                            raise RuntimeError('CODEX_PROTOCOL_REJECTED')
                        self.event('rpc_returned', method=method, requestId=self.sequence)
                        return message['result']
        raise RuntimeError('CODEX_PROTOCOL_TIMEOUT')

    def initialize(self):
        result = self.send('initialize', {'clientInfo': {
            'name': 'veneer_fixture_preauth', 'version': '1.0.0'},
            'capabilities': {'experimentalApi': False}})
        if result.get('codexHome') != str(self.work / 'codex') or '/0.145.0 ' not in result.get('userAgent', ''):
            raise RuntimeError('CODEX_NATIVE_PROFILE_MISMATCH')
        self.child.stdin.write(b'{"method":"initialized"}\n'); self.child.stdin.flush()
        return {'userAgent': result['userAgent'], 'privateCodexHomeVerified': True}

    def close(self):
        self.child.stdin.close()
        try:
            self.child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(self.child.pid, signal.SIGKILL); self.child.wait()
            raise RuntimeError('CODEX_SHUTDOWN_UNKNOWN')
        finally:
            self.selector.close()
            self.child.stdout.close(); self.child.stderr.close()
        self.event('process_exited', exitCode=self.child.returncode)
        if self.child.returncode != 0:
            raise RuntimeError('CODEX_BOOTSTRAP_FAILED')


def preflight(root):
    if boundary.platform.system() != 'Darwin' or boundary.platform.machine() != 'arm64':
        raise RuntimeError('CODEX_HOST_UNSUPPORTED')
    resources = inventory()  # Before native execution.
    if not root.is_absolute() or root.parent.resolve(strict=True) != root.parent:
        raise RuntimeError('CODEX_PRIVATE_PARENT_REQUIRED')
    os.umask(0o077)
    root.mkdir(mode=0o700)  # Exclusive; never adopt a populated/shared home.
    root = root.resolve(strict=True)
    result = {'schema': 'veneer-codex-preauth/v1', 'nativeAdmission': False,
              'startedAt': datetime.now(timezone.utc).isoformat(),
              'cliVersion': VERSION, 'cliSha256': BINARY_HASH, 'resources': resources,
              'launcherSha256': boundary.digest(__file__), 'profiles': {}, 'hosts': {},
              'protectedCredentialBoundaryReady': False,
              'credentialBoundaryBlocker': 'PROTECTED_NATIVE_AUTH_BRIDGE_UNACCEPTED',
              'processEnvironmentBoundary':process_environment_boundary(root)}
    for name in ['worker', 'dedicated-auth']:
        work = root / name; work.mkdir(mode=0o700)
        for directory in ['home', 'codex', 'tmp']:
            (work / directory).mkdir(mode=0o700)
        profile = host_profile(work)
        policy = root / (name + '.sb'); policy.write_text(profile)
        result['profiles'][name] = {'sha256': boundary.hashlib.sha256(profile.encode()).hexdigest(),
                                    'policy': profile}
        version = boundary.run(['/usr/bin/sandbox-exec', '-f', str(policy), str(BINARY), '--version'],
                               work, environment(work))
        if version['exitCode'] != 0 or version['stdout'].strip() != VERSION:
            raise RuntimeError('CODEX_VERSION_UNACCEPTED')
        client = PreauthClient(work, policy, auth=name == 'dedicated-auth')
        try:
            initialized = client.initialize()
            account = client.send('account/read', {'refreshToken': False})
            if account != {'account': None, 'requiresOpenaiAuth': True}:
                raise RuntimeError('CODEX_NONEMPTY_AUTH_HOME')
            config = client.send('config/read', {'includeLayers': False})
            effective = config['config']
            store = 'file' if name == 'dedicated-auth' else 'ephemeral'
            if effective.get('cli_auth_credentials_store') != store:
                raise RuntimeError('CODEX_CREDENTIAL_STORE_UNACCEPTED')
            result['hosts'][name] = {**initialized, 'accountAbsent': True,
                                    'credentialStore': store, 'events': client.events}
        finally:
            client.close()
        if (work / 'codex' / 'auth.json').exists() or (work / 'codex' / 'sessions').exists():
            raise RuntimeError('CODEX_PREAUTH_UNEXPECTED_MATERIAL')
    result['finishedAt'] = datetime.now(timezone.utc).isoformat()
    result['deviceSignIn'] = {
        'method': 'account/login/start', 'params': {'type': 'chatgptDeviceCode'},
        'execute': False, 'actualSignInStarted': False,
        'blockers': ['PROTECTED_NATIVE_AUTH_BRIDGE_UNACCEPTED', 'AUTH_INFERENCE_EGRESS_UNACCEPTED']}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state', type=Path, required=True)
    args = parser.parse_args()
    try:
        result = preflight(args.state)
        (args.state / 'preauth.json').write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result))
    except Exception as error:
        code = str(error)
        if not code.startswith('CODEX_'): code = 'CODEX_PREFLIGHT_FAILED'
        print(json.dumps({'error': code, 'nativeAdmission': False}))
        raise SystemExit(1)


if __name__ == '__main__':
    main()
