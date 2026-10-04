# Synthetic PTY test only: fake node never opens a network connection.
import os
from pathlib import Path
import pty
import select
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts' / 'qq-private-diagnostic.py'

class PrivateInputFlow(unittest.TestCase):
    def exercise(self, confirm):
        with tempfile.TemporaryDirectory(prefix='qq-private-input-test-') as directory:
            marker = Path(directory) / 'invoked'
            node = Path(directory) / 'node'
            node.write_text('#!' + sys.executable + '\n' + '''import os,sys,json
from pathlib import Path
assert sys.argv[2:] == ['--probe','--confirm-official-read']
assert os.environ['QQ_APP_ID']=='fixture-bot'
assert os.environ['QQ_BOT_SECRET']=='fixture-hidden-secret'
assert os.environ['QQ_API_PROFILE']=='tencent-sdk'
Path(os.environ['FIXTURE_MARKER']).write_text('called')
print(json.dumps({'status':'provider_discovery_passed','stage':'gateway_policy','requests':2,'last_http_status':200,'credentials_written':False,'live_gateway_connected':False,'current_dot_connected':False,'messages_received':0,'messages_sent':0,'secret':'fixture-hidden-secret'}))
''')
            node.chmod(0o700)
            master, slave = pty.openpty()
            env = dict(os.environ, PATH=directory + os.pathsep + os.environ['PATH'], FIXTURE_MARKER=str(marker))
            process = subprocess.Popen([sys.executable, str(SCRIPT), '--profile', 'tencent-sdk'],
                                       stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
            os.close(slave)
            output = b''
            def read_until(text):
                nonlocal output
                end = time.monotonic() + 5
                while text.encode() not in output:
                    if time.monotonic() > end: raise AssertionError('Synthetic PTY step timed out')
                    if select.select([master], [], [], 0.1)[0]: output += os.read(master, 8192)
            try:
                read_until('AppID of your existing QQ bot:')
                os.write(master,b'fixture-bot\n')
                read_until('Existing AppSecret (hidden):')
                os.write(master,b'fixture-hidden-secret\n')
                read_until('Type RUN to submit')
                self.assertNotIn(b'fixture-hidden-secret',output)
                os.write(master,confirm.encode()+b'\n')
                process.wait(timeout=5)
                while select.select([master], [], [], 0.1)[0]:
                    try: output += os.read(master,8192)
                    except OSError: break
                self.assertEqual(process.returncode,0)
                self.assertNotIn(b'fixture-hidden-secret',output)
                self.assertEqual(marker.exists(),confirm=='RUN')
                if confirm=='RUN':
                    self.assertIn(b'"requests": 2',output)
                    self.assertIn(b'"credentials_written": false',output)
                else: self.assertIn(b'Cancelled. Nothing submitted.',output)
            finally:
                if process.poll() is None:process.kill();process.wait()
                os.close(master)
    def test_user_submit_no_echo_no_raw_secret(self): self.exercise('RUN')
    def test_user_cancel_no_child_started(self): self.exercise('CANCEL')
    def test_noninteractive_input_rejected(self):
        r=subprocess.run([sys.executable,str(SCRIPT),'--profile','tencent-sdk'],input='fixture-secret',capture_output=True,text=True)
        self.assertNotEqual(r.returncode,0)
        self.assertNotIn('fixture-secret',r.stdout+r.stderr)

if __name__=='__main__':unittest.main()
