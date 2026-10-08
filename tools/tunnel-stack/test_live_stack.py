import contextlib
import copy
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import shutil
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('live_stack', Path(__file__).with_name('live-stack.py'))
stack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stack)


class LiveStackTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='live-stack-synthetic-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        if sys.platform == 'win32':
            self.root /= 'private-fixture'
            with stack.windows_runtime().win.Directory(str(self.root), create=True): pass
        self.private = self.root / 'bridge-private'
        self.patch = mock.patch.multiple(stack, ROOT=self.root, PRIVATE=self.private, BASE=self.root,
                                         NODE=sys.executable, CLIENT=self.root / 'tunnel-client',
                                         PROFILE=self.root/'profile.yaml', LOCK=self.root/'stack.lock',
                                         STOP=self.root/'stack.stop', STATE=self.root/'state.json', LOG=self.root/'events.jsonl')
        self.patch.start()
        self.addCleanup(self.patch.stop)
        for name, result in [('prepare_runtime', None), ('existing_client', False)]:
            patch = mock.patch.object(stack, name, return_value=result)
            patch.start(); self.addCleanup(patch.stop)
        self.plan = {'channels': ['qq', 'lark']}
        for channel in ('qq', 'lark'):
            directory = self.private / channel
            self.plan[channel] = {
                'app_id': '1234567890' if channel == 'qq' else 'cli_aabbccddeeff0011',
                'credentials_file': str(directory / 'credentials.json'),
                'storage_key_file': str(directory / 'storage-key'),
                'database_path': str(directory / 'bridge.sqlite'),
                'lock_directory': str(self.private / 'locks'),
                'callback_hosts': []}

    def test_default_and_missing_confirmation_never_open_credentials_or_start(self):
        for arguments in ([], ['--plan'], ['--run'], ['--run', '--config', '/not/read.json']):
            with (mock.patch.object(stack, 'run', side_effect=AssertionError('activation attempted')),
                 mock.patch.object(stack, 'load_plan', side_effect=AssertionError('file read attempted')),
                 contextlib.redirect_stdout(io.StringIO()) as output):
                result = stack.main(arguments)
            self.assertIn(result, (0, 1))
            self.assertNotIn('secret', output.getvalue())

    def test_validation_is_nonsecret_and_rejects_scope_injection(self):
        clean = stack.validate_plan(self.plan)
        self.assertEqual(clean['channels'], ['qq', 'lark'])
        invalid = []
        for key, value in [('app_id', '123; execute'), ('credentials_file', '/tmp/other-account.json'),
                           ('storage_key_file', str(self.private / 'qq/../lark/storage-key')),
                           ('callback_hosts', ['*.example.com']), ('callback_hosts', ['127.0.0.1']),
                           ('callback_hosts', ['https://example.com/path']), ('callback_hosts', ['a.example.com'] * 2)]:
            plan = copy.deepcopy(self.plan)
            plan['qq'][key] = value
            invalid.append(plan)
        plan = copy.deepcopy(self.plan); plan['qq']['command'] = ['synthetic']; invalid.append(plan)
        plan = copy.deepcopy(self.plan); plan['channels'] = ['qq', 'unknown']; invalid.append(plan)
        plan = copy.deepcopy(self.plan); plan['qq']['storage_key_file'] = plan['qq']['credentials_file']; invalid.append(plan)
        for plan in invalid:
            with self.assertRaises(stack.PlanError):
                stack.validate_plan(plan)
        # No referenced credential or storage file was created or inspected.
        self.assertFalse(self.private.exists())

    def test_only_explicit_channels_activate_and_environment_is_file_only(self):
        plan = {'channels': ['qq'], 'qq': self.plan['qq']}
        inherited = {'HTTPS_PROXY': 'synthetic-managed-proxy', 'NO_PROXY': 'synthetic.invalid', 'SSL_CERT_FILE': '/synthetic/ca',
                     'SSL_CERT_DIR': '/synthetic/ca-directory', 'NODE_EXTRA_CA_CERTS': '/synthetic/node-ca.pem',
                     'NODE_USE_SYSTEM_CA': '1', 'NODE_OPTIONS': '--require=synthetic-forbidden-module',
                     'NODE_TLS_REJECT_UNAUTHORIZED': '0', 'NODE_USE_ENV_PROXY': '1',
                     'QQ_BOT_SECRET': 'synthetic-forbidden', 'STORAGE_KEY': 'synthetic-forbidden',
                     'LARK_APP_SECRET': 'synthetic-forbidden', 'OPENAI_API_KEY': 'synthetic-forbidden'}
        command, _, env = stack.child_spec('qq', plan, inherited)
        self.assertIn('--confirm-persistent-service', command)
        self.assertEqual(env['TUNNEL_SERVICE_OPERATION'], 'live')
        self.assertEqual(env['MCP_CALLBACK_ALLOWED_HOSTS'], '')
        self.assertEqual(env['HTTPS_PROXY'], inherited['HTTPS_PROXY'])
        self.assertEqual(env['SSL_CERT_FILE'], inherited['SSL_CERT_FILE'])
        self.assertTrue(all('synthetic-forbidden' not in value for value in env.values()))
        command, _, env = stack.child_spec('lark', plan, inherited)
        self.assertEqual(command[-1], 'scripts/run-tunnel-readiness.js')
        self.assertEqual(env['LARK_TRANSPORT'], 'disabled')
        self.assertEqual(env['TUNNEL_SERVICE_OPERATION'], 'readiness')
        self.assertNotIn('LARK_CREDENTIALS_FILE', env)
        _, _, env = stack.aggregate_spec(plan, inherited)
        self.assertEqual(env['TUNNEL_LIVE_CHANNELS'], 'qq')
        self.assertEqual((env['HOST'], env['PORT'], env['QQ_MCP_PORT'], env['LARK_MCP_PORT']),
                         ('127.0.0.1', '8789', '8787', '8788'))
        for selected in (self.plan, {'channels': []}):
            environments = [stack.child_spec(channel, selected, inherited)[2] for channel in ('qq', 'lark')]
            environments.append(stack.aggregate_spec(selected, inherited)[2])
            environments.append(stack.environment(inherited))
            for child_env in environments:
                for key in ('HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_SYSTEM_CA'):
                    self.assertEqual(child_env[key], inherited[key])
                for key in ('NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_USE_ENV_PROXY', 'OPENAI_API_KEY'):
                    self.assertNotIn(key, child_env)
                self.assertTrue(all('synthetic-forbidden' not in value for value in child_env.values()))
        absent = stack.environment({})
        self.assertNotIn('NODE_EXTRA_CA_CERTS', absent)
        self.assertNotIn('NODE_USE_SYSTEM_CA', absent)

    def test_library_run_gate_precedes_ports_processes_and_metadata(self):
        with mock.patch.object(stack, 'ports_available', side_effect=AssertionError('port touched')), \
             mock.patch.object(stack.subprocess, 'run', side_effect=AssertionError('process touched')), \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(stack.run(self.plan), 1)
            self.assertEqual(stack.run({'channels': ['invalid']}, approved=True), 1)

    def test_provider_logs_project_only_enums_and_booleans(self):
        raw={'event':'service_status','stage':'waiting_dot_subscription','gateway_phase':'waiting_subscription',
             'gateway_connected':False,'authenticated_subscription_active':False,'ready_for_owner_message':False,
             'message':'synthetic-secret','callback_url':'https://synthetic.invalid/private','identity':'synthetic-owner'}
        projected=stack.project_provider_event('qq',raw)
        self.assertEqual(projected['provider_gate'],'waiting_dot_subscription')
        self.assertFalse(projected['provider_connected'])
        self.assertNotIn('synthetic',json.dumps(projected))
        self.assertIsNone(stack.project_provider_event('qq',{'event':'unknown','secret':'synthetic'}))
        projected=stack.project_provider_event('lark',{'event':'lark_discovery_platform_rejected','error':'synthetic-secret'})
        self.assertEqual(projected,{'channel':'lark','provider_event':'lark_discovery_platform_rejected'})

    def test_callback_transport_logs_preserve_only_fixed_configuration_evidence(self):
        blocked={'ready':False,'mode':'blocked','reason':'proxy_policy_unverified','proxy_configured':True,
                 'destination_binding':'unverified','network_checked':False}
        for channel, event in [('qq',{'event':'service_status','stage':'pending_callback_transport'}),
                               ('lark',{'event':'service_heartbeat'})]:
            result=stack.project_provider_event(channel,{**event,'callback_transport':blocked,'raw':'synthetic-secret'})
            self.assertEqual(result['callback_transport'],blocked)
            self.assertNotIn('synthetic-secret',json.dumps(result))
            for key,value in [('reason','synthetic-secret'),('network_checked',True),('mode',{}),('ready',True),
                              ('proxy_configured','synthetic-secret'),('destination_binding','synthetic-secret'),('callback_url','synthetic-secret')]:
                invalid={**blocked,key:value}
                result=stack.project_provider_event(channel,{**event,'callback_transport':invalid})
                self.assertNotIn('callback_transport',result)
        for mode,binding,proxy in [('direct','direct_pinned',False),('owner_single_message_proxy','unverified',True)]:
            value={'ready':True,'mode':mode,'reason':'none','proxy_configured':proxy,'destination_binding':binding,'network_checked':False}
            self.assertEqual(stack.project_callback_transport(value),value)
        self.assertIsNone(stack.project_callback_transport({'ready':True,'mode':'managed','reason':'none','proxy_configured':True,'destination_binding':'delegated_unverified','network_checked':False}))
        self.assertIsNone(stack.project_callback_transport({**blocked,'reason':'transport_unverified'}))
        unknown={**blocked,'reason':'transport_unverified','proxy_configured':None}
        self.assertEqual(stack.project_callback_transport(unknown),unknown)

    def test_metadata_files_and_status_never_echo_untrusted_fields(self):
        state = self.root / 'state.json'
        with mock.patch.object(stack, 'STATE', state):
            record = {'time': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'stage': 'online',
                      'authenticated_poll': True, 'raw': 'synthetic-secret-must-not-echo'}
            stack.safe_file(state, writing=True, text=json.dumps(record))
            with contextlib.redirect_stdout(io.StringIO()) as output:
                with mock.patch.object(stack, 'configure_runtime'):
                    self.assertEqual(stack.main(['--status', '--runtime-config', 'synthetic']), 0)
            self.assertNotIn('synthetic-secret', output.getvalue())
            self.assertEqual(json.loads(output.getvalue())['stage'], 'online')
        destination = self.root / 'destination.json'
        stack.safe_file(destination, writing=True, text='unchanged')
        link = self.root / 'link.json'
        if sys.platform == 'win32':
            subprocess.run(['C:\\Windows\\System32\\cmd.exe', '/d', '/c', 'mklink', '/J', str(link), str(destination)], check=True, stdout=subprocess.DEVNULL)
        else: link.symlink_to(destination)
        with self.assertRaises(OSError): stack.safe_file(link, writing=True, text='changed')
        self.assertEqual(destination.read_text(), 'unchanged')
        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(stack.main(['--unknown', 'synthetic-secret-must-not-echo']), 1)
        self.assertNotIn('synthetic-secret', output.getvalue())

    def test_fixed_port_conflict_blocks_before_client_or_lock(self):
        with mock.patch.object(stack.socket, 'socket') as fake_socket, \
             mock.patch.object(stack, 'existing_client', side_effect=AssertionError('client checked')), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            fake_socket.return_value.bind.side_effect = OSError('synthetic occupied port')
            self.assertEqual(stack.run(self.plan, approved=True), 1)
        self.assertEqual(json.loads(output.getvalue())['stage'], 'fixed_port_conflict')

    def test_uncertain_shutdown_retains_lease_and_requires_review(self):
        state, log, lock, stop = (self.root / name for name in ('state.json', 'events.jsonl', 'stack.lock', 'stack.stop'))
        stop.write_bytes(b'stop\n')
        with mock.patch.multiple(stack, STATE=state, LOG=log, LOCK=lock, STOP=stop), \
             mock.patch.object(stack, 'ports_available', return_value=True), \
             mock.patch.object(stack.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1)), \
             mock.patch.object(stack.subprocess, 'Popen', side_effect=AssertionError('child started despite stop')), \
             mock.patch.object(stack, 'stop_children', return_value={'all_exited': True, 'forced': True, 'graceful': False}), \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(stack.run(self.plan, approved=True), 1)
        self.assertTrue(lock.exists()); self.assertTrue(stop.exists())
        self.assertEqual(json.loads(state.read_text())['stage'], 'stop_incomplete_requires_review')

    def test_stop_reaps_only_its_own_children_and_handles_timeout(self):
        class FakeProcess:
            def __init__(self, timeout=False):
                self.code = None; self.timeout = timeout; self.actions = []
            def poll(self):
                return self.code
            def terminate(self):
                self.actions.append('terminate')
            def kill(self):
                self.actions.append('kill'); self.code = -9
            def wait(self, timeout):
                self.actions.append('wait')
                if self.timeout and self.code is None:
                    raise subprocess.TimeoutExpired('synthetic', timeout)
                self.code = self.code if self.code is not None else 0
        first, slow, unrelated = FakeProcess(), FakeProcess(True), FakeProcess()
        outcome=stack.stop_children([first, slow])
        self.assertTrue(outcome['all_exited']); self.assertTrue(outcome['forced']); self.assertFalse(outcome['graceful'])
        self.assertEqual(first.actions, ['terminate', 'wait'])
        self.assertEqual(slow.actions, ['terminate', 'wait', 'kill', 'wait'])
        self.assertEqual(unrelated.actions, [])
        for code in (1, -15):
            exited=FakeProcess(); exited.code=code
            result=stack.stop_children([exited])
            self.assertTrue(result['all_exited']); self.assertFalse(result['graceful'])
        success=FakeProcess(); success.code=0
        self.assertTrue(stack.stop_children([success])['graceful'])

    def test_replaced_lease_preserves_foreign_lock_and_stop_marker(self):
        stack.STOP.write_bytes(b'stop\n')
        def replace_lease(_children):
            foreign = self.root / 'foreign.lock'
            stack.safe_file(foreign, writing=True, text='synthetic-foreign-owner')
            if sys.platform == 'win32':
                with self.assertRaises(OSError): foreign.replace(stack.LOCK)
                return {'all_exited': True, 'forced': False, 'graceful': True}
            foreign.replace(stack.LOCK)
            return {'all_exited': True, 'forced': False, 'graceful': True}
        with mock.patch.object(stack, 'ports_available', return_value=True), \
             mock.patch.object(stack.subprocess, 'Popen', side_effect=AssertionError('child started despite stop')), \
             mock.patch.object(stack, 'stop_children', side_effect=replace_lease), \
             contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(stack.run(self.plan, approved=True), 0 if sys.platform == 'win32' else 1)
        if sys.platform == 'win32':
            self.assertEqual((self.root/'foreign.lock').read_text(), 'synthetic-foreign-owner')
            self.assertFalse(stack.LOCK.exists()); self.assertFalse(stack.STOP.exists())
            self.assertEqual(json.loads(stack.STATE.read_text())['stage'], 'stopped')
            return
        self.assertEqual(stack.LOCK.read_text(), 'synthetic-foreign-owner')
        self.assertTrue(stack.STOP.exists())
        self.assertEqual(json.loads(stack.STATE.read_text())['stage'], 'stop_incomplete_requires_review')

    def test_full_supervisor_lifecycle_uses_only_mock_children_and_redacts_logs(self):
        state, log, lock, stop = (self.root / name for name in ('state.json', 'events.jsonl', 'stack.lock', 'stack.stop'))
        children = []
        class FakeProcess:
            def __init__(self, command, **_kwargs):
                self.code = None
                self.stdout = io.BytesIO((
                    'synthetic-secret-must-not-reach-log\n' +
                    json.dumps({'event':'service_status','stage':'waiting_dot_subscription',
                                'gateway_phase':'waiting_subscription','gateway_connected':False,'raw':'synthetic-secret'}) + '\n' +
                    json.dumps({'event':'service_heartbeat','gateway_state':'idle','gateway_connected':False,'raw':'synthetic-secret'}) + '\n').encode())
                if '--health.url-file' in command:
                    Path(command[command.index('--health.url-file')+1]).write_text('http://127.0.0.1:12345')
                children.append(self)
            def poll(self): return self.code
            def terminate(self): self.code = 0
            def wait(self, timeout): return self.code
        with mock.patch.multiple(stack, PROFILE=self.root/'synthetic-profile', WINDOW_SECONDS=0,
                                 STATE=state, LOG=log, LOCK=lock, STOP=stop), \
             mock.patch.object(stack, 'ports_available', return_value=True), \
             mock.patch.object(stack, 'get_health', return_value=(200, {'status':'ok','details':{'last_success':'synthetic'}})), \
             mock.patch.object(stack.subprocess, 'Popen', side_effect=FakeProcess), \
             mock.patch.object(stack.time, 'sleep'), \
             contextlib.redirect_stdout(io.StringIO()) as stdout:
            result = stack.run(stack.validate_plan(self.plan), approved=True)
        self.assertEqual(result, 0)
        self.assertEqual(len(children), 4)
        self.assertTrue(all(child.poll() is not None for child in children))
        self.assertEqual(json.loads(state.read_text())['stage'], 'stopped')
        self.assertFalse(lock.exists()); self.assertFalse(stop.exists())
        self.assertNotIn('synthetic-secret', log.read_text() + stdout.getvalue())
        self.assertIn('provider_status', log.read_text())
        self.assertIn('connection_window_expired', log.read_text())

    def runtime_manifest(self, directory=None):
        directory = directory or self.root
        manifest = directory / 'runtime.json'
        manifest.write_text(json.dumps({'tunnel_client': str(directory/'bin/tunnel-client'),
            'tunnel_profile': str(directory/'config/profile.yaml'),
            'private_root': str(directory/'private'), 'state_root': str(directory/'state')}))
        return manifest

    def test_runtime_manifest_uses_external_locations_and_never_reads_credentials(self):
        manifest = self.runtime_manifest()
        original = Path.read_text
        reads = []
        def read(path, *args, **kwargs):
            reads.append(path)
            if path != manifest: raise AssertionError('referenced file read')
            return original(path, *args, **kwargs)
        with mock.patch.object(Path, 'read_text', read):
            stack.configure_runtime(manifest, sys.executable)
        self.assertEqual(reads, [manifest])
        self.assertEqual(stack.LOCK, self.root/'state/stack.lock')
        self.assertEqual(stack.STOP, self.root/'state/stack.stop')
        self.assertFalse((self.root/'private').exists())
        self.assertFalse((self.root/'state').exists())
        command, cwd, env = stack.aggregate_spec({'channels': []}, {})
        self.assertEqual(cwd, stack.QQ_REPO/'packages/dot-bridge-tunnel')
        self.assertNotIn('--confirm-live', command)
        self.assertEqual(env['TUNNEL_SERVICE_OPERATION'], 'readiness')
        self.assertEqual(env['TUNNEL_LIVE_CHANNELS'], '')

    def test_repo_runtime_locations_and_overlapping_roots_are_rejected(self):
        manifest = self.runtime_manifest()
        original = json.loads(manifest.read_text())
        for key in original:
            value = dict(original); value[key] = str(stack.QQ_REPO/'must-not-write')
            manifest.write_text(json.dumps(value))
            with self.assertRaises(stack.PlanError): stack.configure_runtime(manifest)
        for state in (original['private_root'], original['private_root']+'/state', str(self.root)):
            value = dict(original); value['state_root'] = state
            manifest.write_text(json.dumps(value))
            with self.assertRaises(stack.PlanError): stack.configure_runtime(manifest)
        manifest.write_text(json.dumps(original))
        with self.assertRaises(stack.PlanError): stack.configure_runtime(manifest, 'relative-node')

    def test_clone_parent_and_current_working_directory_do_not_select_source(self):
        clone_parent = self.root / 'arbitrary clone parent'
        launcher_dir = clone_parent / 'dot-qq-bridge/tools/tunnel-stack'
        launcher_dir.mkdir(parents=True)
        source = Path(__file__).with_name('live-stack.py')
        destination = launcher_dir / source.name
        shutil.copyfile(source, destination)
        spec = importlib.util.spec_from_file_location('synthetic_relocated_stack', destination)
        relocated = importlib.util.module_from_spec(spec); spec.loader.exec_module(relocated)
        self.assertEqual(relocated.QQ_REPO, clone_parent/'dot-qq-bridge')
        self.assertEqual(relocated.LARK_REPO, clone_parent/'dot-lark-bridge')
        self.assertEqual(relocated.AGGREGATE_REPO, clone_parent/'dot-qq-bridge/packages/dot-bridge-tunnel')
        with mock.patch.object(relocated, 'configure_runtime', side_effect=AssertionError('configuration read')), \
             mock.patch.object(relocated.subprocess, 'Popen', side_effect=AssertionError('process started')), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(relocated.main(['--plan', '--runtime-config', '/not/read']), 0)
        self.assertFalse(json.loads(output.getvalue())['credentials_read'])
        self.assertFalse(json.loads(output.getvalue())['network_checked'])

    def test_live_and_readiness_share_exclusive_lease_and_stop(self):
        manifest = self.runtime_manifest()
        stack.configure_runtime(manifest, sys.executable)
        if sys.platform == 'win32':
            with stack.windows_runtime().win.Directory(str(stack.BASE), create=True): pass
        else: stack.BASE.mkdir(mode=0o700)
        stack.safe_file(stack.LOCK, writing=True, text='synthetic-owner')
        with mock.patch.object(stack, 'ports_available', return_value=True), \
             mock.patch.object(stack, 'PRIVATE', self.private), \
             mock.patch.object(stack.subprocess, 'Popen', side_effect=AssertionError('competing process started')), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(stack.run({'channels': []}, approved=True, readiness=True), 1)
            self.assertEqual(stack.run(self.plan, approved=True), 1)
            self.assertEqual(stack.main(['--stop', '--runtime-config', str(manifest)], readiness=True), 0)
        self.assertTrue(stack.STOP.exists())
        self.assertEqual(stack.LOCK.read_text(), 'synthetic-owner')
        self.assertEqual(output.getvalue().count('stack_lock_requires_review'), 2)

    def test_readiness_default_and_confirmation_gate_are_offline(self):
        for args in ([], ['--plan'], ['--run'], ['--check'], ['--run', '--runtime-config', '/not/read']):
            with mock.patch.object(stack, 'configure_runtime', side_effect=AssertionError('configuration read')), \
                 mock.patch.object(stack, 'run', side_effect=AssertionError('runtime attempted')), \
                 contextlib.redirect_stdout(io.StringIO()):
                self.assertIn(stack.main(args, readiness=True), (0, 1))
        _, _, env = stack.child_spec('qq', {'channels': []}, {'QQ_BOT_SECRET': 'synthetic-forbidden'})
        self.assertEqual(env['QQ_TRANSPORT'], 'disabled')
        self.assertNotIn('QQ_CREDENTIALS_FILE', env)
        self.assertNotIn('QQ_BOT_SECRET', env)



if __name__ == '__main__':
    unittest.main()
