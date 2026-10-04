import contextlib
import importlib.util
import io
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
import base64
import http.client
import json
import os
import shutil
import socket

spec = importlib.util.spec_from_file_location('windows_test_stack', Path(__file__).with_name('live-stack.py'))
stack = importlib.util.module_from_spec(spec); spec.loader.exec_module(stack)

@unittest.skipUnless(sys.platform == 'win32', 'Native Windows supervisor integration')
class NativeSupervisorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='windows-supervisor-synthetic-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'private'
        self.native = stack.windows_runtime()
        with self.native.win.Directory(str(self.root), create=True): pass

    def owned(self, code, *, console=False):
        job = self.native.OwnedJob(); self.addCleanup(job.close)
        startup = subprocess.STARTUPINFO(); startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW; startup.wShowWindow = 0
        process = subprocess.Popen([sys.executable, '-I', '-S', '-c', code], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, creationflags=4 | (subprocess.CREATE_NEW_CONSOLE if console else subprocess.CREATE_NO_WINDOW), startupinfo=startup)
        self.addCleanup(lambda: process.kill() if process.poll() is None else None)
        self.addCleanup(lambda: process.stdout.close())
        self.addCleanup(lambda: process.stdin.close() if not process.stdin.closed else None)
        job.adopt_suspended(process)
        process._dot_owned_windows = True; process._dot_private_stop = not console
        return job, process

    def test_real_lockfileex_lease_refuses_replacement_and_second_owner(self):
        path = self.root / 'stack.lock'
        lease = self.native.Lease(path)
        try:
            with self.assertRaises(OSError): self.native.Lease(path)
            with self.assertRaises(OSError): path.rename(self.root/'replaced.lock')
            lease.release()
        finally: lease.close()
        self.assertFalse(path.exists())
        self.assertEqual(list(self.root.iterdir()), [])

    def test_owned_hidden_child_uses_private_pipe_and_exits_gracefully(self):
        job, child = self.owned("import sys; raise SystemExit(0 if sys.stdin.buffer.readline() == b'stop\\n' else 1)")
        result = stack.stop_children([child], grace_seconds=5)
        self.assertEqual(result, {'all_exited': True, 'forced': False, 'graceful': True})
        self.assertTrue(job.wait_empty())

    def test_bounded_forced_stop_reports_uncertainty(self):
        job, child = self.owned('import time; time.sleep(60)')
        started = time.monotonic()
        result = stack.stop_children([child], grace_seconds=.1)
        self.assertTrue(result['forced']); self.assertFalse(result['graceful']); self.assertTrue(result['all_exited'])
        self.assertLess(time.monotonic()-started, 6)
        job.terminate(); self.assertTrue(job.wait_empty())

    def test_job_close_reaps_owned_descendants_and_leaves_unrelated_process_alive(self):
        unrelated = subprocess.Popen([sys.executable, '-I', '-S', '-c', 'import time; time.sleep(60)'], creationflags=subprocess.CREATE_NO_WINDOW)
        def reap_unrelated():
            if unrelated.poll() is None: unrelated.kill()
            unrelated.wait(timeout=5)
        self.addCleanup(reap_unrelated)
        job, child = self.owned("import subprocess,sys,time; subprocess.Popen([sys.executable,'-I','-S','-c','import time; time.sleep(60)']); print('ready',flush=True); time.sleep(60)")
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor() as pool:
            self.assertEqual(pool.submit(child.stdout.readline).result(timeout=5), b'ready\r\n')
        self.assertGreaterEqual(job.active(), 2)
        job.close(); child.wait(timeout=5)
        self.assertIsNone(unrelated.poll())

    def test_process_conflict_guard_uses_current_process_basename_without_arguments(self):
        self.assertTrue(self.native.existing_client(Path(sys.executable)))
        self.assertFalse(self.native.existing_client(Path('synthetic-not-a-real-client-98f19d.exe')))

    def test_hidden_owned_console_accepts_ctrl_break_graceful_stop(self):
        job, child = self.owned("import signal,sys,time; signal.signal(signal.SIGBREAK,lambda *_:sys.exit(0)); print('ready',flush=True); exec('while True: time.sleep(.02)')", console=True)
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor() as pool:
            self.assertEqual(pool.submit(child.stdout.readline).result(timeout=5), b'ready\r\n')
        result = stack.stop_children([child], grace_seconds=5)
        self.assertEqual(result, {'all_exited': True, 'forced': False, 'graceful': True})
        self.assertTrue(job.wait_empty())

    def test_real_qq_lark_and_aggregate_readiness_children_use_private_keys_and_close_cleanly(self):
        # Actual bridge entrypoints, empty in-memory databases, no workers,
        # provider binding, Events subscription, callback or Tunnel client.
        node = shutil.which('node')
        self.assertIsNotNone(node)
        private = self.root/'tunnel'
        with self.native.win.Directory(str(private), create=True): pass
        keys = [base64.urlsafe_b64encode(bytes([i])*32).decode().rstrip('=') for i in (21,22,23)]
        files = [private/name for name in ('qq-service-key','lark-service-key','aggregate-service-key')]
        for file, key in zip(files,keys): self.native.win.write_new(str(file),key.encode())
        job = self.native.OwnedJob(); self.addCleanup(job.close)
        for channel, repo, entry, key in [('qq',stack.QQ_REPO,'scripts/run-tunnel-readiness.js',files[0]),
                ('lark',stack.LARK_REPO,'scripts/run-tunnel-readiness.js',files[1]),
                ('aggregate',stack.AGGREGATE_REPO,'src/main.js',files[2])]:
            with self.subTest(channel=channel):
                with socket.socket() as reserved:
                    reserved.bind(('127.0.0.1',0)); port=reserved.getsockname()[1]
                env={'SystemRoot':os.environ['SystemRoot'],'WINDIR':os.environ['WINDIR'],
                    'PATH':str(Path(node).parent),'DOT_BRIDGE_PYTHON':sys.executable,'DOT_BRIDGE_SUPERVISED':'1',
                    'AUTH_MODE':'tunnel-service','BRIDGE_MODE':'tunnel','TUNNEL_SERVICE_OPERATION':'readiness',
                    'TUNNEL_SERVICE_OWNER_ID':'tunnel-owner:dot-bridge','TUNNEL_SERVICE_KEY_FILE':str(key),
                    'HOST':'127.0.0.1','PORT':str(port),'QQ_TRANSPORT':'disabled','LARK_TRANSPORT':'disabled',
                    'QQ_SERVICE_KEY_FILE':str(files[0]),'LARK_SERVICE_KEY_FILE':str(files[1])}
                if channel == 'aggregate':
                    env.pop('QQ_TRANSPORT'); env.pop('LARK_TRANSPORT')
                child=subprocess.Popen([node,entry],cwd=repo,env=env,stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,creationflags=4|subprocess.CREATE_NO_WINDOW)
                def close(child=child):
                    if child.poll() is None: child.kill()
                    child.wait(timeout=5)
                    if not child.stdin.closed: child.stdin.close()
                self.addCleanup(close)
                job.adopt_suspended(child); child._dot_owned_windows=True; child._dot_private_stop=True
                deadline=time.monotonic()+30
                while True:
                    self.assertIsNone(child.poll(),'readiness process exited before health')
                    connection=http.client.HTTPConnection('127.0.0.1',port,timeout=.5)
                    try:
                        connection.request('GET','/healthz'); response=connection.getresponse()
                        value=json.loads(response.read(4096)); self.assertEqual(response.status,200)
                        self.assertEqual(value['status'],'ok'); break
                    except OSError:
                        if time.monotonic()>=deadline: self.fail('bounded readiness startup deadline')
                        time.sleep(.02)
                    finally: connection.close()
                self.assertEqual(stack.stop_children([child],grace_seconds=15),{'all_exited':True,'forced':False,'graceful':True})
                self.assertTrue(job.wait_empty())

    def test_mixed_aggregate_configuration_refuses_before_keys_and_exits_with_stdin_still_open(self):
        node = shutil.which('node'); self.assertIsNotNone(node)
        env={'SystemRoot':os.environ['SystemRoot'],'PATH':str(Path(node).parent),'DOT_BRIDGE_PYTHON':sys.executable,
            'DOT_BRIDGE_SUPERVISED':'1','AUTH_MODE':'tunnel-service','BRIDGE_MODE':'tunnel',
            'TUNNEL_SERVICE_KEY_FILE':str(self.root/'missing-a'),'QQ_SERVICE_KEY_FILE':str(self.root/'missing-b'),
            'LARK_SERVICE_KEY_FILE':str(self.root/'missing-c'),'QQ_TRANSPORT':'disabled'}
        job=self.native.OwnedJob(); self.addCleanup(job.close)
        child=subprocess.Popen([node,'src/main.js'],cwd=stack.AGGREGATE_REPO,env=env,stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=4|subprocess.CREATE_NO_WINDOW)
        def close():
            if child.poll() is None: child.kill()
            child.wait(timeout=5)
            child.stdin.close(); child.stdout.close(); child.stderr.close()
        self.addCleanup(close); job.adopt_suspended(child)
        # Keep our writer open: startup rejection must not await a stop request.
        self.assertEqual(child.wait(timeout=5),1)
        self.assertEqual(child.stdout.read(8192),b'')
        self.assertEqual(child.stderr.read(8192),b'Readiness aggregator refused or failed; no secret values printed.\n')
        self.assertEqual(list(self.root.iterdir()),[]); self.assertTrue(job.wait_empty())

if __name__ == '__main__': unittest.main()
