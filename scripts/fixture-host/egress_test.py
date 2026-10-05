#!/usr/bin/env python3
"""Real synthetic TLS/proxy and kernel receipts, never provider authentication."""
import argparse
from datetime import datetime, timezone
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import bootstrap
import codex
import egress


def certificate(root):
    # One ephemeral synthetic self-signed CA/leaf; private bytes never printed,
    # reported or retained. Only public cert hash enters receipts.
    cert,key = root/'public.pem',root/'synthetic.key'
    command=['/usr/bin/openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1',
             '-subj','/CN=synthetic-only','-keyout',str(key),'-out',str(cert),
             '-config',str(root/'openssl.cnf')]
    (root/'openssl.cnf').write_text('[req]\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\n[ext]\n'
        'basicConstraints=critical,CA:TRUE\nsubjectAltName=DNS:auth.openai.com,DNS:chatgpt.com,IP:127.0.0.1\n')
    subprocess.run(command,env=bootstrap.ENV,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL,check=True,timeout=10,close_fds=True)
    cert.chmod(0o600); key.chmod(0o600)
    return cert,key


class Origin(BaseHTTPRequestHandler):
    count = 0
    mode = 'ok'
    def log_message(self,*args): pass  # Do not log requests or secret values.
    def do_POST(self):
        Origin.count += 1
        body=self.rfile.read(int(self.headers['content-length']))
        assert body.startswith(b'{"fixture":')
        if Origin.mode == 'cutoff': self.connection.close(); return
        status=302 if Origin.mode=='redirect' else 429 if Origin.mode=='429' else 200
        self.send_response(status)
        if Origin.mode=='redirect': self.send_header('Location','https://unapproved.invalid/')
        self.send_header('Content-Length','2'); self.end_headers(); self.wfile.write(b'{}')


class Enforcement(unittest.TestCase):
    observations=[]
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir='/private/tmp')
        self.root=Path(self.temp.name).resolve()
        self.cert,self.key=certificate(self.root)
        self.scope={'owner':'synthetic-owner','setup':'fixture-setup','run':'fixture-run',
                    'session':'fixture-session','customer':'fixture-customer','order':'fixture-order',
                    'cli':codex.BINARY_HASH,'profile':'a'*64}
        self.ledger=egress.Ledger(self.root/'ledger.sqlite',self.scope)
        Origin.count=0; Origin.mode='ok'
        self.origin=ThreadingHTTPServer(('127.0.0.1',0),Origin)
        tls=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); tls.load_cert_chain(self.cert,self.key)
        self.origin.socket=tls.wrap_socket(self.origin.socket,server_side=True)
        self.gateway=egress.Gateway(self.ledger,self.cert,self.key,self.origin.server_port,self.cert)
        self.threads=[]
        for server in [self.origin,self.gateway]:
            thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start(); self.threads.append(thread)
        self.body=b'{"fixture":"synthetic-control"}'
        self.host='auth.openai.com'; self.path='/api/accounts/deviceauth/usercode'
        self.headers={'host':self.host,'content-type':'application/json','content-length':str(len(self.body))}

    def tearDown(self):
        for server in [self.gateway,self.origin]: server.shutdown(); server.server_close()
        for thread in self.threads: thread.join(3)
        self.ledger.close(); self.temp.cleanup()

    def authorize(self, **kw):
        return self.ledger.authorize_synthetic(kw.get('scope',self.scope),kw.get('host',self.host),
            kw.get('path',self.path),kw.get('headers',self.headers),kw.get('body',self.body),kw.get('ttl',5))

    def request(self, host=None, path=None, headers=None, body=None, sni=None, ca=None):
        host=host or self.host; path=path or self.path
        conn=socket.create_connection(self.gateway.server_address,timeout=3)
        conn.sendall(('CONNECT '+host+':443 HTTP/1.1\r\nHost: '+host+':443\r\n\r\n').encode())
        response=conn.recv(4096)
        if not response.startswith(b'HTTP/1.1 200'): conn.close(); return 403
        context=ssl.create_default_context(cafile=str(ca or self.cert))
        try:
            with context.wrap_socket(conn,server_hostname=sni or host) as tls:
                wire='POST '+path+' HTTP/1.1\r\n'+''.join(k+': '+v+'\r\n' for k,v in (headers or self.headers).items())+'\r\n'
                tls.sendall(wire.encode()+(self.body if body is None else body))
                result=tls.recv(8192)
                return int(result.split(b' ')[1]) if result.startswith(b'HTTP/1.1') else 403
        except (ssl.SSLError,OSError): conn.close(); return 403

    def wait_receipt(self,intent):
        for _ in range(30):
            result=self.ledger.read(intent)
            if result: return result
            time.sleep(.01)
        return None

    def test_actual_tls_exact_wire_and_no_replay(self):
        for host,path in egress.ROUTES:
            self.host=host; self.path=path; self.headers['host']=host
            intent=self.authorize()
            self.assertEqual(self.request(),200)
            receipt=self.wait_receipt(intent)
            self.assertEqual(receipt['outcome'],'SYNTHETIC_ACCEPTED')
            self.assertFalse(receipt['replayAllowed'])
            before=Origin.count
            self.assertEqual(self.request(),403)
            self.assertEqual(Origin.count,before)
            self.observations.append({'kind':'synthetic_tls_route','host':host,'path':path,'receipt':receipt})
        self.assertEqual(Origin.count,4)
        for request in [dict(host='127.0.0.1'),dict(host='unapproved.invalid'),
                        dict(path='/oauth/token?redirect=private'),dict(path='/oauth/../token'),
                        dict(sni='chatgpt.com'),dict(headers={**self.headers,'host':'127.0.0.1'}),
                        dict(headers={**self.headers,'transfer-encoding':'chunked'}),
                        dict(headers={**self.headers,'connection':'upgrade'}),dict(body=b'{"fixture":"changed"}')]:
            self.assertEqual(self.request(**request),403,request)
        self.assertEqual(Origin.count,4)

    def test_scope_expiry_revocation_tls_and_unknown(self):
        for field in self.scope:
            with self.assertRaises(egress.Denied): self.authorize(scope={**self.scope,field:'wrong'})
        intent=self.authorize(ttl=.001); time.sleep(.01)
        self.assertEqual(self.request(),403); self.assertIsNone(self.ledger.read(intent))
        for mode in ['redirect','429','cutoff']:
            Origin.mode=mode; intent=self.authorize()
            self.assertIn(self.request(),[403,429])
            receipt=self.wait_receipt(intent)
            self.assertEqual(receipt['outcome'],'REJECTED' if mode=='429' else 'UNKNOWN')
            before=Origin.count; self.assertEqual(self.request(),403); self.assertEqual(Origin.count,before)
            self.observations.append({'kind':'synthetic_failure','failure':mode,'receipt':receipt})
        intent=self.authorize(); self.ledger.revoke(); self.assertEqual(self.request(),403)
        self.assertIsNone(self.ledger.read(intent))
        with self.assertRaises(egress.Denied): self.authorize()
        # Persistence does not recreate pending wire grants or permit UNKNOWN replay.
        self.ledger.close(); self.ledger=egress.Ledger(self.root/'ledger.sqlite',self.scope)
        self.assertEqual(self.request(),403)
        with self.assertRaises(Exception): self.ledger.db.execute('DELETE FROM intents')
        with self.assertRaisesRegex(egress.Denied,'DURABLE_SCOPE_MISMATCH'):
            egress.Ledger(self.root/'ledger.sqlite',{**self.scope,'customer':'fixture-other'})

    def test_tls_identity_forgery_connect_and_admission(self):
        self.assertEqual(self.request(sni='unapproved.invalid'),403)
        # A CA from a separate synthetic private directory cannot authenticate
        # this gateway, even at the allowed local port.
        unrelated=self.root/'unrelated'; unrelated.mkdir(mode=0o700)
        cert,_key=certificate(unrelated)
        self.assertEqual(self.request(ca=cert),403)
        with socket.create_connection(self.gateway.server_address,timeout=3) as conn:
            conn.sendall(b'CONNECT auth.openai.com:443 HTTP/1.1\r\nHost: auth.openai.com:443\r\nProxy-Authorization: synthetic\r\n\r\n')
            self.assertTrue(conn.recv(4096).startswith(b'HTTP/1.1 403'))
        intent=self.authorize()
        with self.assertRaisesRegex(egress.Denied,'DUPLICATE_PENDING'): self.authorize()
        self.assertEqual(self.request(headers={**self.headers,'authorization':'Bearer synthetic-forged'}),403)
        self.assertEqual(self.request(),200)
        self.assertEqual(self.wait_receipt(intent)['outcome'],'SYNTHETIC_ACCEPTED')
        self.gateway.upstream_tls=ssl.create_default_context(cafile=str(cert))
        unknown=self.authorize()
        self.assertEqual(self.request(),403)
        self.assertEqual(self.wait_receipt(unknown)['outcome'],'UNKNOWN')
        self.assertEqual(Origin.count,1)
        for i in range(5): self.authorize(body=('{"fixture":"control-'+str(i)+'"}').encode())
        with self.assertRaisesRegex(egress.Denied,'ADMISSION_CAP'):
            self.authorize(body=b'{"fixture":"overflow"}')
        self.observations.append({'kind':'tls_identity_scope_admission','alternateCaRejected':True,
            'unexpectedSniRejected':True,'proxyAuthorizationRejected':True,'forgedHeaderRejected':True,
            'pendingCap':5,'bodyOrSecretsLogged':False})

    def test_kernel_exact_socket_and_native_ephemeral_file_denial(self):
        work=self.root/'worker'; work.mkdir(mode=0o700)
        for name in ['home','codex','tmp']: (work/name).mkdir(mode=0o700)
        ca=work/'proxy-ca.pem'; ca.write_bytes(self.cert.read_bytes()); ca.chmod(0o600)
        executable=work/'probe'
        compiled=bootstrap.run(['/usr/bin/clang','-Wall','-Wextra','-Werror','-o',str(executable),
            str(bootstrap.SOURCE/'egress-socket-probe.c')],work)
        self.assertEqual(compiled['exitCode'],0)
        with socket.socket() as other:
            other.bind(('127.0.0.1',0)); other.listen(10)
            port=self.gateway.server_address[1]
            policy=codex.host_profile(work,executable)+'(allow network-outbound (remote tcp "localhost:'+str(port)+'"))\n'+ \
                '(deny file-write* (literal '+bootstrap.quote(ca)+'))\n'
            args=[str(executable),str(port),str(other.getsockname()[1])]
            control=json.loads(bootstrap.run(args,work)['stdout'])
            actual=bootstrap.run(['/usr/bin/sandbox-exec','-p',policy,*args],work)
            self.assertEqual(actual['exitCode'],0)
            observed=json.loads(actual['stdout'])
            self.assertEqual(control,{'allowedTcp':0,'alternateTcp':0,'alternateUdp':0})
            self.assertEqual(observed,{'allowedTcp':0,'alternateTcp':1,'alternateUdp':1})
            self.observations.append({'kind':'kernel_exact_socket','control':control,'active':observed,
                'profileSha256':hashlib.sha256(policy.encode()).hexdigest()})
            # The network exception must not broaden credentials, FDs or spawn.
            compiled=bootstrap.run(['/usr/bin/clang','-Wall','-Wextra','-Werror','-o',str(executable),
                str(bootstrap.SOURCE/'probe.c')],work)
            self.assertEqual(compiled['exitCode'],0)
            allowed=work/'fixture'; allowed.write_text('synthetic')
            cache=work/'codex'/'auth.json'; cache.write_text('SYNTHETIC-CONTROL')
            alias=work/'alias'; alias.symlink_to(self.key)
            with socket.socket(socket.AF_UNIX) as unix:
                unix_path=self.root/'probe.sock'; unix.bind(str(unix_path)); unix.listen(10)
                args=[str(executable),str(allowed),str(self.key),str(cache),
                    str(other.getsockname()[1]),str(unix_path),str(work/'write'),str(alias)]
                result=bootstrap.run(['/usr/bin/sandbox-exec','-p',policy,*args],work,codex.environment(work))
                self.assertEqual(result['exitCode'],0)
                observed=json.loads(result['stdout'])
                for field in ['deniedReadErrno','deniedWriteErrno','deniedTcpErrno','deniedUnixErrno',
                              'ownSpawnErrno','otherSpawnErrno','symlinkReadErrno']:
                    self.assertEqual(observed[field],1,field)
                self.assertEqual(observed['forkResult'],1)
                self.assertTrue(observed['fd3Closed']); self.assertTrue(observed['parentMarkerAbsent'])
                args[3]=str(ca)
                ca_result=bootstrap.run(['/usr/bin/sandbox-exec','-p',policy,*args],work,codex.environment(work))
                self.assertEqual(ca_result['exitCode'],0)
                self.assertEqual(json.loads(ca_result['stdout'])['deniedWriteErrno'],1)
                cache.unlink()
                self.observations.append({'kind':'proxy_profile_credential_and_effect_denials','active':observed,
                    'publicCaWriteErrno':1})
        # Actual Codex preauth under exact proxy socket profile and public CA env.
        # No auth, thread or inference RPC can cross PreauthClient.
        policy=work/'native.sb'; policy.write_text(egress.native_proxy_profile(work,port))
        environment=egress.native_proxy_environment(work,port,ca)
        with patch.object(codex,'environment',return_value=environment):
            client=codex.PreauthClient(work,policy,auth=True)
            try:
                initialized=client.initialize()
                self.assertEqual(client.send('account/read',{'refreshToken':False}),{'account':None,'requiresOpenaiAuth':True})
                self.assertEqual(client.send('config/read',{'includeLayers':False})['config']['cli_auth_credentials_store'],'ephemeral')
            finally: client.close()
        self.observations.append({'kind':'native_proxy_environment_preauth','initialized':initialized,
            'events':client.events,'inferenceCompatible':None,'authCompatible':None,
            'publicCaSha256':hashlib.sha256(ca.read_bytes()).hexdigest()})


if __name__=='__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('--receipt',type=Path); args=parser.parse_args()
    suite=unittest.defaultTestLoader.loadTestsFromTestCase(Enforcement)
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    if args.receipt:
        receipt={'schema':'fixture-synthetic-egress/v1','createdAt':datetime.now(timezone.utc).isoformat(),
            'passed':result.wasSuccessful(),'tests':result.testsRun,'syntheticOnly':True,
            'nativeAuthAccepted':False,'nativeInferenceAccepted':False,'realSignInStarted':False,
            'productionInstalled':False,'observations':Enforcement.observations,
            'assets':{name:bootstrap.digest(bootstrap.SOURCE/name) for name in
                ['egress.py','egress_test.py','egress-socket-probe.c','codex.py','bootstrap.py']}}
        with args.receipt.open('x') as stream: json.dump(receipt,stream,indent=2)
    raise SystemExit(0 if result.wasSuccessful() else 1)
