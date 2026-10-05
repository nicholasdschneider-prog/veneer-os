#!/usr/bin/env python3
"""Synthetic-only TLS-intercepting native HTTPS proxy. No public upstream mode.

The supported integration is HTTPS_PROXY + CODEX_CA_CERTIFICATE, not token
injection. This executable accepts no real identities or arbitrary destinations.
The trusted owner supervisor must authorize each exact wire request independently
of a model; the proxy never supplies credentials. All bodies/headers remain in
memory, never in receipts. Production native wire compatibility is UNACCEPTED.
"""
import hashlib
import hmac
import http.client
import json
import os
from pathlib import Path
import socket
import socketserver
import sqlite3
import ssl
import threading
import time
import uuid
import bootstrap
import codex

LIMIT = 1024 * 1024
# Public v0.145.0 source routes. No wildcard domains, query strings or redirects.
ROUTES = {
    ('auth.openai.com', '/api/accounts/deviceauth/usercode'): 'device-start',
    ('auth.openai.com', '/api/accounts/deviceauth/token'): 'device-poll',
    ('auth.openai.com', '/oauth/token'): 'token',
    ('chatgpt.com', '/backend-api/codex/responses'): 'inference',
}
SCOPE = {'owner', 'setup', 'run', 'session', 'customer', 'order', 'cli', 'profile'}


class Denied(Exception):
    pass


def private(path):
    path = Path(path)
    stat = path.lstat()
    if (path.resolve() != path or path.is_symlink() or not path.is_file() or
            stat.st_uid != os.getuid() or stat.st_nlink != 1 or stat.st_mode & 0o077):
        raise Denied('PRIVATE_MATERIAL_REQUIRED')
    return path


def wire_hash(authority, path, headers, body):
    # Values only participate in an internal keyed comparison; no request data
    # is exposed by receipts. Different authorization headers cannot reuse intent.
    return hashlib.sha256(json.dumps([authority, path, sorted(headers.items())],
                                     separators=(',', ':')).encode() + b'\0' + body).digest()


class Ledger:
    def __init__(self, path, scope):
        if set(scope) != SCOPE or not all(isinstance(v, str) and v for v in scope.values()):
            raise Denied('SCOPE_REQUIRED')
        if scope['cli'] != codex.BINARY_HASH or len(scope['profile']) != 64:
            raise Denied('HOST_BINDING_REQUIRED')
        if any(not scope[k].startswith('fixture-') for k in ['setup','run','session','customer','order']):
            raise Denied('SYNTHETIC_SCOPE_REQUIRED')
        self.scope = dict(scope)
        self.key = os.urandom(32)  # Never stored, returned, inherited or logged.
        self.lock = threading.Lock()
        path = Path(path)
        parent = path.parent
        if (not path.is_absolute() or parent.resolve() != parent or
                parent.stat().st_uid != os.getuid() or parent.stat().st_mode & 0o077):
            raise Denied('PRIVATE_PARENT_REQUIRED')
        if path.exists(): private(path)
        self.db = sqlite3.connect(path, check_same_thread=False)
        os.chmod(path, 0o600)
        self.db.executescript('''
          PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
          CREATE TABLE IF NOT EXISTS scope(binding TEXT PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY, binding TEXT NOT NULL,
            phase TEXT NOT NULL, state TEXT NOT NULL CHECK(state='UNKNOWN'));
          CREATE TABLE IF NOT EXISTS outcomes(id TEXT PRIMARY KEY REFERENCES intents(id),
            status INTEGER NOT NULL, accepted INTEGER NOT NULL);
          CREATE TRIGGER IF NOT EXISTS immutable_intent BEFORE UPDATE ON intents
            BEGIN SELECT RAISE(ABORT,'immutable'); END;
          CREATE TRIGGER IF NOT EXISTS retain_intent BEFORE DELETE ON intents
            BEGIN SELECT RAISE(ABORT,'immutable'); END;
          CREATE TRIGGER IF NOT EXISTS immutable_outcome BEFORE UPDATE ON outcomes
            BEGIN SELECT RAISE(ABORT,'immutable'); END;
          CREATE TRIGGER IF NOT EXISTS retain_outcome BEFORE DELETE ON outcomes
            BEGIN SELECT RAISE(ABORT,'immutable'); END;
          CREATE TRIGGER IF NOT EXISTS immutable_scope BEFORE UPDATE ON scope
            BEGIN SELECT RAISE(ABORT,'immutable'); END;
          CREATE TRIGGER IF NOT EXISTS retain_scope BEFORE DELETE ON scope
            BEGIN SELECT RAISE(ABORT,'immutable'); END;
        ''')
        binding = hashlib.sha256(json.dumps(scope,sort_keys=True).encode()).hexdigest()
        existing = self.db.execute('SELECT binding FROM scope').fetchall()
        if existing and existing != [(binding,)]:
            self.db.close(); raise Denied('DURABLE_SCOPE_MISMATCH')
        if not existing:
            self.db.execute('INSERT INTO scope VALUES(?)',(binding,)); self.db.commit()
        self.pending = {}
        self.revoked = False

    def authorize_synthetic(self, scope, authority, path, headers, body, ttl=5):
        """Trusted test/supervisor call, never exposed through the network proxy.

        Only synthetic bodies allowed here. There is intentionally no public
        real-provider authorization API, credential input or production switch.
        """
        if scope != self.scope or self.revoked or not 0 < ttl <= 15:
            raise Denied('SCOPE_OR_LIFECYCLE_DENIED')
        phase = ROUTES.get((authority, path))
        if phase is None or not body.startswith(b'{"fixture":'):
            raise Denied('SYNTHETIC_REQUEST_REQUIRED')
        if len(body) > LIMIT: raise Denied('BUDGET')
        digest = hmac.digest(self.key, wire_hash(authority,path,headers,body), 'sha256')
        intent = str(uuid.uuid4())
        with self.lock:
            if len(self.pending) >= 5: raise Denied('ADMISSION_CAP')
            if digest in self.pending: raise Denied('DUPLICATE_PENDING')
            self.pending[digest] = (intent, phase, time.monotonic() + ttl)
        return intent

    def reserve(self, authority, path, headers, body):
        digest = hmac.digest(self.key, wire_hash(authority,path,headers,body), 'sha256')
        with self.lock:
            entry = self.pending.pop(digest, None)
            if self.revoked or entry is None or entry[2] < time.monotonic():
                raise Denied('UNAPPROVED_OR_EXPIRED')
            intent, phase, _ = entry
            binding = hmac.new(self.key, json.dumps(self.scope,sort_keys=True).encode(), 'sha256').hexdigest()
            self.db.execute('INSERT INTO intents VALUES(?,?,?,?)', (intent,binding,phase,'UNKNOWN'))
            self.db.commit()  # Before upstream attempt. No retry on 429/cutoff.
            return intent

    def finish(self, intent, status):
        with self.lock:
            self.db.execute('INSERT INTO outcomes VALUES(?,?,?)', (intent,status,int(200 <= status < 300)))
            self.db.commit()

    def read(self, intent):
        with self.lock:
            row = self.db.execute('SELECT status,accepted FROM outcomes WHERE id=?',(intent,)).fetchone()
            pending = self.db.execute('SELECT phase FROM intents WHERE id=?',(intent,)).fetchone()
        if not pending: return None
        return {'id':intent,'phase':pending[0],'status':row[0] if row else None,
                'outcome':'SYNTHETIC_ACCEPTED' if row and row[1] else 'REJECTED' if row else 'UNKNOWN',
                'replayAllowed':False,'nativeAcceptance':False}

    def revoke(self):
        with self.lock:
            self.revoked = True
            self.pending.clear()

    def close(self):
        self.revoke()
        self.db.close()


def read_request(stream):
    line = stream.readline(4097)
    if len(line) > 4096 or not line.endswith(b'\r\n'): raise Denied('HTTP_LINE')
    try: method, target, version = line[:-2].decode('ascii').split(' ')
    except (ValueError, UnicodeError): raise Denied('HTTP_LINE')
    if version != 'HTTP/1.1': raise Denied('HTTP_VERSION')
    headers = {}
    size = 0
    while True:
        line = stream.readline(8193); size += len(line)
        if size > 16384 or not line.endswith(b'\r\n'): raise Denied('HTTP_HEADERS')
        if line == b'\r\n': break
        try:
            name, value = line[:-2].decode('ascii').split(':',1)
            name = name.lower()
            if not name or not all(c.isalnum() or c == '-' for c in name): raise ValueError()
            if name in headers: raise ValueError()
            if any(ord(c) < 32 or ord(c) > 126 for c in value): raise ValueError()
            headers[name] = value.strip()
        except (UnicodeError,ValueError): raise Denied('HTTP_HEADERS')
    return method,target,headers


def read_exact(stream, length):
    result = bytearray()
    while len(result) < length:
        part = stream.read(length-len(result))
        if not part: raise Denied('TRUNCATED')
        result.extend(part)
    return bytes(result)


class Gateway(socketserver.ThreadingTCPServer):
    allow_reuse_address = False
    daemon_threads = True
    def handle_error(self, request, client_address):
        # socketserver's default prints arbitrary exception/locals context.
        # Fail the connection silently; a reserved intent remains UNKNOWN.
        pass
    def __init__(self, ledger, certificate, key, upstream_port, upstream_ca):
        # Fixed synthetic peer only. No URL, DNS name, provider token or public
        # upstream argument exists. TLS validates the synthetic localhost peer.
        if not 1024 <= upstream_port <= 65535: raise Denied('UPSTREAM_REQUIRED')
        self.ledger = ledger
        self.upstream_port = upstream_port
        self.upstream_tls = ssl.create_default_context(cafile=str(private(upstream_ca)))
        self.tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.tls.minimum_version = ssl.TLSVersion.TLSv1_2
        self.tls.load_cert_chain(private(certificate), private(key))
        def sni(sock, name, _context):
            if name not in {h for h,_ in ROUTES}: return ssl.ALERT_DESCRIPTION_UNRECOGNIZED_NAME
            sock.fixture_sni = name
        self.tls.set_servername_callback(sni)
        self.slots = threading.BoundedSemaphore(5)
        super().__init__(('127.0.0.1',0), Handler)


class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        server = self.server
        if not server.slots.acquire(blocking=False): return
        try:
            self.request.settimeout(3)
            # Unbuffered prevents plaintext pipelining into the TLS handshake.
            stream = self.request.makefile('rb',buffering=0)
            method,target,headers = read_request(stream)
            if (method != 'CONNECT' or target not in {h+':443' for h,_ in ROUTES} or
                    headers != {'host':target}): raise Denied('CONNECT_DENIED')
            authority = target[:-4]
            stream.close()
            self.request.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
            tls = server.tls.wrap_socket(self.request,server_side=True)
            with tls:
                if tls.fixture_sni != authority: raise Denied('AUTHORITY_MISMATCH')
                stream = tls.makefile('rb',buffering=0)
                method,path,headers = read_request(stream)
                allowed = {'host','content-type','content-length','authorization','chatgpt-account-id'}
                if (method != 'POST' or (authority,path) not in ROUTES or
                        headers.get('host') != authority or set(headers)-allowed or
                        headers.get('content-type') not in {'application/json','application/x-www-form-urlencoded'}):
                    raise Denied('REQUEST_DENIED')
                length = headers.get('content-length','')
                if not length.isdecimal() or len(length)>7 or not 0 < int(length) <= LIMIT:
                    raise Denied('REQUEST_BUDGET')
                body = read_exact(stream,int(length))
                intent = server.ledger.reserve(authority,path,headers,body)
                # No incoming proxy headers forwarded, no automatic redirects,
                # retries, compression or WebSocket upgrades. Secret header/body
                # bytes pass directly in memory to the approved synthetic peer.
                upstream = http.client.HTTPSConnection('127.0.0.1',server.upstream_port,
                    context=server.upstream_tls,timeout=3)
                try:
                    upstream.request('POST',path,body,headers)
                    result = upstream.getresponse()
                    data = result.read(LIMIT+1)
                    if len(data)>LIMIT or 300 <= result.status < 400 or result.getheader('Location'):
                        raise Denied('RESPONSE_DENIED')
                    server.ledger.finish(intent,result.status)
                    tls.sendall(('HTTP/1.1 '+str(result.status)+' Synthetic\r\nContent-Length: '+
                                 str(len(data))+'\r\nConnection: close\r\n\r\n').encode()+data)
                finally:
                    upstream.close()
                    stream.close()
        except (Denied,OSError,ValueError,http.client.HTTPException):
            # Never log exceptions: TLS/HTTP errors may contain identity material.
            try: self.request.sendall(b'HTTP/1.1 403 Denied\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
            except OSError: pass
        finally:
            server.slots.release()


def native_proxy_profile(work, port):
    if not 1024 <= port <= 65535: raise Denied('PROXY_PORT_REQUIRED')
    # Seatbelt's address grammar permits localhost, not literal IPv4. TLS trust
    # plus the fixed IPv4 proxy environment supplies the additional identity
    # boundary. This is not a claim of IPv4-only kernel filtering.
    return codex.host_profile(work) + '(allow network-outbound (remote tcp "localhost:'+str(port)+'"))\n' + \
        '(deny file-write* (literal '+bootstrap.quote(work/'proxy-ca.pem')+'))\n'


def native_proxy_environment(work, port, ca):
    # Proxy/CA are public material; credentials NEVER enter environment.
    private(ca)
    if Path(ca) != work/'proxy-ca.pem': raise Denied('PRIVATE_CA_REQUIRED')
    if not 1024 <= port <= 65535: raise Denied('PROXY_PORT_REQUIRED')
    proxy = 'http://127.0.0.1:'+str(port)
    return {**codex.environment(work),'HTTPS_PROXY':proxy,'HTTP_PROXY':proxy,
            'ALL_PROXY':proxy,'NO_PROXY':'','CODEX_CA_CERTIFICATE':str(ca)}
