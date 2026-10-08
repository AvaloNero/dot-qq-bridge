#!/usr/bin/env python3
"""Private live-stack launcher. Default is a non-network plan, never activation."""
import argparse
try:
    import fcntl
except ImportError:
    fcntl = None
import http.client
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import stat
import threading
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit

QQ_REPO = Path(__file__).resolve().parents[2]
ROOT = QQ_REPO.parent
LARK_REPO = ROOT / 'dot-lark-bridge'
AGGREGATE_REPO = QQ_REPO / 'packages/dot-bridge-tunnel'
# Runtime locations are supplied explicitly; importing/default planning touches none.
BASE = PRIVATE = NODE = CLIENT = PROFILE = None
# The readiness launcher uses this same lease; never run competing main clients.
LOCK = STOP = STATE = LOG = None
TRUSTED_NODE_PATH = '/usr/local/bin:/usr/bin:/bin'
WINDOW_SECONDS = 1800
PROXY_KEYS = ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy',
              'https_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
              'NODE_EXTRA_CA_CERTS', 'NODE_USE_SYSTEM_CA')
CHANNELS = ('qq', 'lark')
PORTS = {'qq': 8787, 'lark': 8788, 'aggregate': 8789}
SETTINGS = {'app_id', 'credentials_file', 'storage_key_file', 'database_path',
            'lock_directory', 'callback_hosts'}
QQ_PHASES = {'stopped','waiting_subscription','waiting_lease','discovering','connecting','waiting_hello',
             'authenticating','connected','retrying','quota_exhausted','blocked_configuration',
             'blocked_account_or_protocol','retry_limit','acceptance_failed','connection_closed',
             'connection_error','handshake_timeout','heartbeat_timeout','inbound_rate_limited',
             'invalid_session','send_failed','server_reconnect','unknown'}
QQ_STAGES = {'pending_callback_policy','pending_callback_transport','waiting_configuration','waiting_dot_subscription',
             'gateway_blocked','gateway_connected','waiting_gateway','status_unavailable'}
LARK_PHASES = {'disabled','connecting','reconnecting','connected','failed','idle','unknown'}
LARK_EVENTS = {'service_heartbeat','service_listening','gateway_disconnected','lark_connected','lark_reconnected',
               'lark_reconnecting','lark_connection_failed','lark_sdk_warning','lark_sdk_error','inbound_rejected',
               'lark_discovery_started','lark_discovery_failed','lark_discovery_http_received',
               'lark_discovery_http_rejected','lark_discovery_invalid','lark_discovery_platform_rejected',
               'lark_discovery_endpoint_verified','service_heartbeat_failed'}


def project_callback_transport(value):
    if not isinstance(value, dict) or set(value) != {'ready','mode','reason','proxy_configured','destination_binding','network_checked'}:
        return None
    if type(value['ready']) is not bool or value['network_checked'] is not False or not (value['proxy_configured'] is None or type(value['proxy_configured']) is bool):
        return None
    if not all(isinstance(value[key], str) for key in ('mode','reason','destination_binding')):
        return None
    expected = {
        'direct': (True, 'none', False, 'direct_pinned'),
        'owner_single_message_proxy': (True, 'none', True, 'unverified')}
    if value['mode'] in expected:
        if (value['ready'],value['reason'],value['proxy_configured'],value['destination_binding']) != expected[value['mode']]: return None
    elif value['mode'] == 'blocked':
        if value['ready'] or value['destination_binding'] != 'unverified' or value['reason'] not in {'proxy_policy_unverified','proxy_unsupported','adapter_invalid','transport_unverified'}: return None
        if value['reason'] == 'proxy_policy_unverified' and value['proxy_configured'] is not True: return None
        if value['reason'] in {'proxy_unsupported','adapter_invalid'} and type(value['proxy_configured']) is not bool: return None
        if value['reason'] == 'transport_unverified' and value['proxy_configured'] is not None: return None
    else: return None
    return dict(value)


def project_provider_event(channel, value):
    """Convert child status into fixed enums/booleans; never forward raw child logs."""
    if not isinstance(value, dict): return None
    if channel == 'qq' and value.get('event') == 'service_status' and value.get('stage') in QQ_STAGES:
        result = {'channel': 'qq', 'provider_event': 'service_status', 'provider_gate': value['stage']}
        phase = value.get('gateway_phase')
        if phase in QQ_PHASES: result['provider_phase'] = phase
        fields = {'gateway_connected':'provider_connected','authenticated_subscription_active':'subscription_active',
                  'ready_for_owner_message':'ready_for_owner_message'}
    elif channel == 'lark' and value.get('event') in LARK_EVENTS:
        result = {'channel': 'lark', 'provider_event': value['event']}
        phase = value.get('gateway_state')
        if phase in LARK_PHASES: result['provider_phase'] = phase
        fields = {'gateway_connected':'provider_connected','mcp_subscription_active':'subscription_active',
                  'ready_for_delivery':'ready_for_owner_message'}
    else: return None
    for source, target in fields.items():
        if type(value.get(source)) is bool: result[target] = value[source]
    transport = project_callback_transport(value.get('callback_transport'))
    if transport is not None: result['callback_transport'] = transport
    return result


class PlanError(Exception):
    pass


def external_path(value):
    if not isinstance(value, str) or not value or len(value) > 2048:
        raise PlanError()
    path = Path(value)
    if not path.is_absolute() or '..' in path.parts or str(path) != value:
        raise PlanError()
    if sys.platform == 'win32': windows_runtime().win.canonical(value)
    resolved = path if sys.platform == 'win32' else path.resolve()
    for repo in (QQ_REPO.resolve(), LARK_REPO.resolve()):
        if resolved == repo or repo in resolved.parents:
            raise PlanError()
    return resolved


def configure_runtime(path, node=None):
    """Read only the small non-secret runtime manifest, never referenced files."""
    global BASE, PRIVATE, NODE, CLIENT, PROFILE, LOCK, STOP, STATE, LOG
    try:
        source = Path(path)
        if source.stat().st_size > 16384: raise PlanError()
        value = json.loads(source.read_text())
        if not isinstance(value, dict) or set(value) != {'tunnel_client', 'tunnel_profile', 'private_root', 'state_root'}:
            raise PlanError()
        client, profile, private, base = [external_path(value[key]) for key in
            ('tunnel_client', 'tunnel_profile', 'private_root', 'state_root')]
        # Do not place binaries/profile, state or mutable HOME among credentials.
        if (private == base or private in base.parents or base in private.parents or
            any(p == private or private in p.parents or p == base or base in p.parents for p in (client, profile)) or
            client == profile): raise PlanError()
        if node is not None:
            selected = Path(node)
            if not selected.is_absolute() or '..' in selected.parts: raise PlanError()
            if sys.platform == 'win32': windows_runtime().win.canonical(str(selected))
            else: selected = selected.resolve()
        else:
            found = shutil.which('node', path=TRUSTED_NODE_PATH)
            selected = Path(found).resolve() if found else None
        BASE, PRIVATE, NODE, CLIENT, PROFILE = base, private, str(selected) if selected else None, client, profile
        LOCK, STOP = base / 'stack.lock', base / 'stack.stop'
        STATE, LOG = base / 'stack-state.json', base / 'stack-events.jsonl'
    except (OSError, ValueError, TypeError, KeyError) as error:
        raise PlanError() from error


def linux_runtime_available():
    return sys.platform == 'linux' and fcntl is not None and Path('/proc/self').exists()


_windows_runtime = None
def windows_runtime():
    global _windows_runtime
    if sys.platform != 'win32': raise RuntimeError('supported_runtime_required')
    if _windows_runtime is None:
        spec = importlib.util.spec_from_file_location('dot_windows_runtime', Path(__file__).with_name('windows-runtime.py'))
        _windows_runtime = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_windows_runtime)
    return _windows_runtime


def runtime_available():
    return sys.platform == 'win32' or linux_runtime_available()


def prepare_runtime():
    """Validate the selected platform without repairing existing permissions."""
    if not runtime_available(): raise RuntimeError('supported_runtime_required')
    if any(value is None for value in (BASE, PRIVATE, NODE, CLIENT, PROFILE)):
        raise RuntimeError('explicit_runtime_configuration_required')
    if sys.platform == 'win32':
        win = windows_runtime().win
        try:
            for binary in (Path(NODE), CLIENT): win.trusted_executable(str(binary))
            win.inspect(str(PROFILE))
            for repo in (QQ_REPO, LARK_REPO, AGGREGATE_REPO):
                if not repo.is_dir(): raise OSError()
            with win.Directory(str(BASE), create=True): pass
            with win.Directory(str(PRIVATE)): pass
            with win.Directory(str(BASE / 'empty-home'), create=True): pass
        except OSError as error: raise RuntimeError('unsafe_runtime_directory') from error
        return
    for binary in (Path(NODE), CLIENT):
        info = binary.stat()
        if not stat.S_ISREG(info.st_mode) or not os.access(binary, os.X_OK) or info.st_mode & 0o022:
            raise RuntimeError('runtime_files_unavailable')
    if not PROFILE.is_file(): raise RuntimeError('runtime_files_unavailable')
    for repo in (QQ_REPO, LARK_REPO, AGGREGATE_REPO):
        if not repo.is_dir(): raise RuntimeError('runtime_files_unavailable')
    BASE.mkdir(mode=0o700, exist_ok=True)
    for directory in (BASE, PRIVATE):
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise RuntimeError('unsafe_runtime_directory')
    home = BASE / 'empty-home'
    home.mkdir(mode=0o700, exist_ok=True)
    info = home.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise RuntimeError('unsafe_runtime_directory')


def existing_client():
    # Read process names only, never command lines or environment/credential bytes.
    if sys.platform == 'win32': return windows_runtime().existing_client(CLIENT)
    names = {'tunnel-client', CLIENT.name[:15]}
    try:
        for entry in Path('/proc').iterdir():
            if not entry.name.isdigit(): continue
            try:
                if (entry / 'comm').read_text(encoding='utf-8', errors='replace').strip() in names: return True
            except FileNotFoundError:
                continue
        return False
    except OSError:
        raise RuntimeError('process_guard_unavailable')


def private_path(value, channel, *, directory=False):
    if not isinstance(value, str) or not value or len(value) > 2048:
        raise PlanError()
    path = Path(value)
    if not path.is_absolute() or str(path) != value or '..' in path.parts:
        raise PlanError()
    permitted = PRIVATE / channel
    if directory and path == PRIVATE / 'locks':
        return value
    if path == permitted or permitted not in path.parents:
        raise PlanError()
    return value


def valid_hostname(value):
    if not isinstance(value, str) or value != value.lower() or len(value) > 253:
        return False
    if not re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?', value):
        return False
    labels = value.split('.')
    if len(labels) < 2 or any(not label or len(label) > 63 or label.startswith('-') or label.endswith('-') for label in labels):
        return False
    try:
        ipaddress.ip_address(value)
        return False
    except ValueError:
        return True


def validate_plan(value):
    if not isinstance(value, dict) or not isinstance(value.get('channels'), list):
        raise PlanError()
    enabled = value['channels']
    if not enabled or len(enabled) > 2 or any(v not in CHANNELS for v in enabled) or len(set(enabled)) != len(enabled):
        raise PlanError()
    if set(value) != {'channels', *enabled}:
        raise PlanError()
    clean = {'channels': [v for v in CHANNELS if v in enabled]}
    files = set()
    for channel in clean['channels']:
        entry = value[channel]
        if not isinstance(entry, dict) or set(entry) != SETTINGS:
            raise PlanError()
        app_id = entry['app_id']
        pattern = r'[0-9]{3,32}' if channel == 'qq' else r'cli_[0-9a-fA-F]{16}'
        if not isinstance(app_id, str) or not re.fullmatch(pattern, app_id):
            raise PlanError()
        hosts = entry['callback_hosts']
        if not isinstance(hosts, list) or len(hosts) > 8 or not all(isinstance(h, str) for h in hosts) or len(set(hosts)) != len(hosts) or not all(valid_hostname(h) for h in hosts):
            raise PlanError()
        result = {'app_id': app_id, 'callback_hosts': list(hosts)}
        for key in ('credentials_file', 'storage_key_file', 'database_path'):
            result[key] = private_path(entry[key], channel)
            if result[key] in files:
                raise PlanError()
            files.add(result[key])
        result['lock_directory'] = private_path(entry['lock_directory'], channel, directory=True)
        clean[channel] = result
    return clean


def load_plan(path):
    # This is a non-secret operator plan. Credential files are never read here.
    try:
        source = Path(path)
        if source.stat().st_size > 16384:
            raise PlanError()
        return validate_plan(json.loads(source.read_text()))
    except (OSError, ValueError, TypeError, KeyError) as error:
        raise PlanError() from error


def environment(inherited):
    result = {key: inherited[key] for key in PROXY_KEYS if key in inherited}
    result.update(PATH=TRUSTED_NODE_PATH, HOME=str(BASE / 'empty-home'))
    if sys.platform == 'win32':
        # Fixed operator-selected binary directory, no inherited PATH or code
        # injection options. Only explicit CA/proxy policy passes through.
        for key in ('SystemRoot', 'WINDIR'):
            if key in inherited: result[key] = inherited[key]
        result.update(PATH=str(Path(NODE).parent), DOT_BRIDGE_PYTHON=sys.executable,
                      USERPROFILE=str(BASE / 'empty-home'), DOT_BRIDGE_SUPERVISED='1')
    return result


def child_spec(channel, plan, inherited):
    env = environment(inherited)
    env.update(AUTH_MODE='tunnel-service', BRIDGE_MODE='tunnel', HOST='127.0.0.1',
               PORT=str(PORTS[channel]), TUNNEL_SERVICE_OWNER_ID='tunnel-owner:dot-bridge',
               TUNNEL_SERVICE_KEY_FILE=str(PRIVATE / 'tunnel' / f'{channel}-service-key'))
    transport = 'QQ_TRANSPORT' if channel == 'qq' else 'LARK_TRANSPORT'
    if channel not in plan['channels']:
        env.update(TUNNEL_SERVICE_OPERATION='readiness', **{transport: 'disabled'})
        return [NODE, 'scripts/run-tunnel-readiness.js'], QQ_REPO if channel == 'qq' else LARK_REPO, env
    entry = plan[channel]
    env.update(TUNNEL_SERVICE_OPERATION='live', STORAGE_KEY_FILE=entry['storage_key_file'],
               DATABASE_PATH=entry['database_path'], BRIDGE_LOCK_DIRECTORY=entry['lock_directory'],
               MCP_CALLBACK_ALLOWED_HOSTS=','.join(entry['callback_hosts']))
    if channel == 'qq':
        env.update(QQ_TRANSPORT='gateway', QQ_APP_ID=entry['app_id'], QQ_API_PROFILE='tencent-sdk',
                   QQ_CREDENTIALS_FILE=entry['credentials_file'])
        command = [NODE, 'scripts/qq-service.js', '--run', '--confirm-persistent-service']
    else:
        env.update(LARK_TRANSPORT='long-connection', LARK_EXPECTED_APP_ID=entry['app_id'],
                   LARK_CREDENTIALS_FILE=entry['credentials_file'])
        command = [NODE, 'scripts/run-tunnel-live.js', '--confirm-live-owner-bridge']
    return command, QQ_REPO if channel == 'qq' else LARK_REPO, env


def aggregate_spec(plan, inherited):
    env = environment(inherited)
    live = bool(plan['channels'])
    env.update(AUTH_MODE='tunnel-service', BRIDGE_MODE='tunnel', TUNNEL_SERVICE_OPERATION='live' if live else 'readiness',
               TUNNEL_LIVE_CHANNELS=','.join(plan['channels']), HOST='127.0.0.1', PORT='8789',
               TUNNEL_SERVICE_OWNER_ID='tunnel-owner:dot-bridge',
               TUNNEL_SERVICE_KEY_FILE=str(PRIVATE / 'tunnel/aggregate-service-key'),
               QQ_SERVICE_KEY_FILE=str(PRIVATE / 'tunnel/qq-service-key'),
               LARK_SERVICE_KEY_FILE=str(PRIVATE / 'tunnel/lark-service-key'),
               QQ_MCP_PORT='8787', LARK_MCP_PORT='8788')
    return [NODE, 'src/main.js', *(['--confirm-live'] if live else [])], AGGREGATE_REPO, env


def get_health(port, path='/healthz'):
    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
    try:
        conn.request('GET', path)
        response = conn.getresponse()
        body = response.read(32769)
        if len(body) > 32768:
            raise ValueError()
        return response.status, json.loads(body)
    finally:
        conn.close()


def safe_file(path, *, writing=False, text=None):
    if sys.platform == 'win32':
        win = windows_runtime().win
        if writing: win.write_metadata(str(path), text.encode('utf-8')); return
        return win.read(str(path), limit=8192).decode('utf-8')
    flags = (os.O_RDWR | os.O_CREAT if writing else os.O_RDONLY) | os.O_NOFOLLOW | os.O_NONBLOCK
    fd = os.open(path, flags, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or (info.st_mode & 0o7777) != 0o600:
            raise OSError('Unsafe metadata file')
        if writing:
            data = text.encode('utf-8')
            if len(data) > 512000: raise OSError('Metadata limit')
            os.ftruncate(fd, 0)
            while data:
                count = os.write(fd, data); data = data[count:]
        else:
            if info.st_size > 8192: raise OSError('Metadata limit')
            return os.read(fd, 8193).decode('utf-8')
    finally:
        os.close(fd)


def ports_available():
    held = []
    try:
        for port in PORTS.values():
            handle = socket.socket(); held.append(handle)
            handle.bind(('127.0.0.1', port))
        return True
    except OSError:
        return False
    finally:
        for handle in held: handle.close()


def stop_children(children, *, grace_seconds=45):
    # Signal all owned children first, then allow one bounded graceful interval.
    forced, failed = False, False
    for process in reversed(children):
        if process.poll() is None:
            try:
                if sys.platform == 'win32' and getattr(process, '_dot_owned_windows', False):
                    if getattr(process, '_dot_private_stop', False):
                        process.stdin.write(b'stop\n'); process.stdin.flush(); process.stdin.close()
                    elif not windows_runtime().request_break(process): failed = True
                else: process.terminate()
            except (OSError, subprocess.SubprocessError): failed = True
    deadline = time.monotonic() + grace_seconds
    for process in reversed(children):
        try:
            if process.poll() is None:
                try: process.wait(timeout=max(0.1, deadline-time.monotonic()))
                except subprocess.TimeoutExpired:
                    forced = True; process.kill(); process.wait(timeout=5)
        except (OSError, subprocess.SubprocessError): failed = True
    exited = all(process.poll() is not None for process in children)
    if any(process.poll() not in (None, 0) for process in children): failed = True
    return {'all_exited': exited, 'forced': forced, 'graceful': exited and not forced and not failed}


def run(plan, *, approved=False, readiness=False, check=False):
    if approved is not True:
        print('{"stage":"explicit_runtime_confirmation_required"}'); return 1
    try:
        if readiness:
            if plan != {'channels': []}: raise PlanError()
        else:
            plan = validate_plan(plan)
    except (PlanError, TypeError, ValueError):
        print('{"stage":"invalid_nonsecret_plan"}'); return 1
    try:
        prepare_runtime()
    except (OSError, RuntimeError) as error:
        allowed = {'supported_runtime_required', 'explicit_runtime_configuration_required',
                   'runtime_files_unavailable', 'unsafe_runtime_directory'}
        label = str(error) if isinstance(error, RuntimeError) and str(error) in allowed else 'runtime_files_unavailable'
        print(json.dumps({'stage': label})); return 1
    if not ports_available():
        print('{"stage":"fixed_port_conflict"}'); return 1
    try: conflict = existing_client()
    except RuntimeError:
        print('{"stage":"process_guard_unavailable"}'); return 1
    if conflict:
        print('{"stage":"existing_client_conflict"}')
        return 1
    try:
        if sys.platform == 'win32':
            native_lease = windows_runtime().Lease(LOCK)
        else:
            lockfd = os.open(LOCK, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            fcntl.flock(lockfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            os.write(lockfd, str(os.getpid()).encode())
    except OSError:
        if 'lockfd' in locals(): os.close(lockfd)
        print('{"stage":"stack_lock_requires_review"}')
        return 1
    children, events, capture_threads = [], [], []
    job = None
    log_lock = threading.Lock()
    stopping = False
    status_code = 0

    def report(stage, *, update_state=True, **fields):
        event = {'time': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'stage': stage,
                 'operation': 'readiness' if readiness else 'live', **fields}
        with log_lock:
            events.append(event)
            del events[:-1000]
            try:
                safe_file(LOG, writing=True, text=''.join(json.dumps(item) + '\n' for item in events))
                if update_state: safe_file(STATE, writing=True, text=json.dumps(event, indent=2))
            except OSError as error:
                raise RuntimeError('metadata_storage_unavailable') from error
            print(json.dumps(event), flush=True)

    def capture(stream, channel):
        try:
            for line in iter(lambda: stream.readline(8192), b''):
                if len(line) >= 8192: continue
                try:
                    projected = project_provider_event(channel, json.loads(line))
                    if projected: report('provider_status', update_state=False, **projected)
                except (ValueError, TypeError, RuntimeError): pass
        finally: stream.close()

    def on_stop(_signal, _frame):
        nonlocal stopping
        stopping = True

    def cancelled():
        return stopping or STOP.exists()

    def launch(spec, provider=None):
        nonlocal job
        if cancelled():
            raise RuntimeError('stop_requested')
        command, cwd, env = spec
        options = {}
        if sys.platform == 'win32':
            # Suspend before assignment so no descendant can escape the owned
            # kill-on-close Job Object. Every console window stays hidden.
            if job is None: job = windows_runtime().OwnedJob()
            startup = subprocess.STARTUPINFO(); startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW; startup.wShowWindow = 0
            options.update(creationflags=4 | (subprocess.CREATE_NO_WINDOW if command[0] == NODE else subprocess.CREATE_NEW_CONSOLE), startupinfo=startup)
        child = subprocess.Popen(command, cwd=cwd, env=env,
                                 stdin=subprocess.PIPE if sys.platform == 'win32' and command[0] == NODE else subprocess.DEVNULL,
                                 stdout=subprocess.PIPE if provider else subprocess.DEVNULL, stderr=subprocess.DEVNULL, **options)
        children.append(child)
        if sys.platform == 'win32' and isinstance(getattr(child, '_handle', None), int):
            child._dot_owned_windows = True; child._dot_private_stop = command[0] == NODE
            try: job.adopt_suspended(child)
            except OSError:
                child.kill(); raise RuntimeError('owned_process_guard_unavailable')
        if provider:
            thread = threading.Thread(target=capture, args=(child.stdout, provider), daemon=True)
            thread.start(); capture_threads.append(thread)
        return child

    def wait_listener(child, port):
        deadline = time.monotonic() + 30
        for _ in range(100):
            if cancelled():
                raise RuntimeError('stop_requested')
            if child.poll() is not None:
                raise RuntimeError('child_start_failed')
            if time.monotonic() >= deadline: raise RuntimeError('listener_timeout')
            try:
                if get_health(port)[0] == 200:
                    time.sleep(.1)
                    if child.poll() is not None: raise RuntimeError('child_start_failed')
                    return
            except (OSError, ValueError, http.client.HTTPException):
                pass
            time.sleep(.1)
        raise RuntimeError('listener_timeout')

    signal.signal(signal.SIGTERM, on_stop)
    signal.signal(signal.SIGINT, on_stop)
    try:
        with tempfile.TemporaryDirectory(prefix='dot-live-stack-') as work:
            report('starting', selected_channels=plan['channels'], provider_delivery_verified=False,
                   operation='readiness' if readiness else 'live')
            for channel in CHANNELS:
                child = launch(child_spec(channel, plan, os.environ), provider=channel if channel in plan['channels'] else None)
                wait_listener(child, PORTS[channel])
            child = launch(aggregate_spec(plan, os.environ))
            wait_listener(child, PORTS['aggregate'])
            if any(child.poll() is not None for child in children): raise RuntimeError('child_stopped')
            report('listeners_ready', provider_delivery_verified=False)
            health_file = Path(work) / 'health.url'
            launch(([str(CLIENT), 'run', '--config', str(PROFILE), '--health.url-file', str(health_file),
                     '--control-plane.poll-timeout', '3s', '--control-plane.initial-poll-timeout', '3s'], BASE, environment(os.environ)))
            health_port = None
            for _ in range(160):
                if cancelled():
                    raise RuntimeError('stop_requested')
                if any(child.poll() is not None for child in children):
                    raise RuntimeError('child_stopped')
                try:
                    url = urlsplit(health_file.read_text().strip())
                    if url.scheme != 'http' or url.hostname != '127.0.0.1' or url.username or url.password:
                        raise RuntimeError('unexpected_health_origin')
                    code, value = get_health(url.port, '/health/control-plane')
                    if code == 200 and value.get('status') == 'ok' and value.get('details', {}).get('last_success'):
                        health_port = url.port
                        break
                except (OSError, ValueError, http.client.HTTPException):
                    pass
                time.sleep(.25)
            if health_port is None:
                raise RuntimeError('poll_not_observed')
            report('online', authenticated_poll=True, selected_channels=plan['channels'], provider_delivery_verified=False)
            deadline = time.monotonic() + WINDOW_SECONDS
            report('connection_window_open', update_state=False, window_seconds=WINDOW_SECONDS)
            next_report = time.monotonic() + 60
            while not check and not cancelled() and time.monotonic() < deadline:
                if any(child.poll() is not None for child in children):
                    raise RuntimeError('child_stopped')
                if time.monotonic() >= next_report:
                    try:
                        code, value = get_health(health_port, '/health/control-plane')
                        healthy = code == 200 and value.get('status') == 'ok'
                    except (OSError, ValueError, http.client.HTTPException):
                        healthy = False
                    report('online' if healthy else 'control_plane_degraded', authenticated_poll=healthy,
                           selected_channels=plan['channels'], provider_delivery_verified=False)
                    next_report = time.monotonic() + 60
                time.sleep(.5)
            if not check and not cancelled(): report('connection_window_expired', update_state=False)
    except Exception as error:
        allowed = {'stop_requested', 'child_start_failed', 'listener_timeout', 'child_stopped',
                   'unexpected_health_origin', 'poll_not_observed', 'metadata_storage_unavailable', 'owned_process_guard_unavailable'}
        label = str(error) if isinstance(error, RuntimeError) and str(error) in allowed else 'runtime_failed'
        try: report(label)
        except RuntimeError: print(json.dumps({'stage':label,'metadata_storage_unavailable':True}))
        status_code = 0 if label == 'stop_requested' else 1
    finally:
        shutdown = stop_children(children)
        if job is not None:
            try:
                if not job.wait_empty():
                    job.terminate(); shutdown.update(forced=True, graceful=False)
                    if not job.wait_empty(): shutdown['all_exited'] = False
            except OSError: shutdown['graceful'] = False
            finally: job.close()
        for thread in capture_threads: thread.join(timeout=1)
        clean = shutdown['graceful']
        if clean:
            try:
                if sys.platform == 'win32':
                    native_lease.release()
                    try: windows_runtime().win.remove_private(str(STOP), expected=b'stop\n')
                    except FileNotFoundError: pass
                else:
                    held, current = os.fstat(lockfd), LOCK.lstat()
                    if (held.st_dev, held.st_ino) == (current.st_dev, current.st_ino):
                        LOCK.unlink(); STOP.unlink(missing_ok=True)
                    else: clean = False
            except OSError:
                clean = False
        if sys.platform == 'win32': native_lease.close()
        else: os.close(lockfd)
        final_stage='stopped' if clean else 'stop_incomplete_requires_review'
        try: report(final_stage, children_stopped=shutdown['all_exited'], forced_shutdown=shutdown['forced'], authenticated_poll=False)
        except RuntimeError: print(json.dumps({'stage':final_stage,'children_stopped':shutdown['all_exited'],'forced_shutdown':shutdown['forced'],'metadata_storage_unavailable':True}))
    return status_code if clean else 1


def main(argv=None, *, readiness=False):
    class SafeArgumentParser(argparse.ArgumentParser):
        def error(self, _message): raise PlanError()
    parser = SafeArgumentParser(description=__doc__)
    parser.add_argument('--plan', action='store_true')
    parser.add_argument('--validate-plan', action='store_true')
    parser.add_argument('--run', action='store_true')
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--confirm-live-runtime', action='store_true')
    parser.add_argument('--confirm-readiness-runtime', action='store_true')
    parser.add_argument('--config')
    parser.add_argument('--runtime-config')
    parser.add_argument('--node', help='Absolute operator-selected Node path; otherwise use the fixed trusted search path')
    parser.add_argument('--status', action='store_true')
    parser.add_argument('--stop', action='store_true')
    try: args = parser.parse_args(argv)
    except PlanError:
        print('{"stage":"invalid_arguments"}'); return 1
    if (sum((args.plan, args.validate_plan, args.run, args.check, args.status, args.stop)) > 1 or
        (args.check and not readiness) or (readiness and (args.confirm_live_runtime or args.config)) or
        (not readiness and args.confirm_readiness_runtime)):
        print('{"stage":"invalid_action"}')
        return 1
    if not any((args.validate_plan, args.run, args.check, args.status, args.stop)):
        print(json.dumps({'mode': 'readiness_stack_plan_only' if readiness else 'live_stack_plan_only',
                          'started': False, 'credentials_read': False, 'network_checked': False,
                          'requires_specific_runtime_approval': True, 'channels': list(CHANNELS),
                          'supported_platform': 'Linux or native Windows NTFS with an existing Python 3 interpreter',
                          'window_seconds': WINDOW_SECONDS,
                          'transport_profile_is_existing_file_reference_only': True,
                          'log_retention': 'latest 1000 fixed-classification events per run; previous run overwritten'}))
        return 0
    if (args.run or args.check) and not (args.confirm_readiness_runtime if readiness else args.confirm_live_runtime):
        print('{"stage":"explicit_plan_and_runtime_confirmation_required"}'); return 1
    if any((args.run, args.check, args.status, args.stop)) and not runtime_available():
        print('{"stage":"supported_runtime_required"}'); return 1
    if not args.runtime_config:
        print('{"stage":"explicit_runtime_configuration_required"}'); return 1
    try: configure_runtime(args.runtime_config, args.node)
    except PlanError:
        print('{"stage":"invalid_runtime_configuration"}'); return 1
    if args.status:
        try:
            value = json.loads(safe_file(STATE))
            import calendar
            age = int(time.time() - calendar.timegm(time.strptime(value['time'], '%Y-%m-%dT%H:%M:%SZ')))
            value['state_age_seconds'] = age
            if value.get('stage') != 'stopped' and (age < 0 or age > 90):
                value.update(stage='state_stale', authenticated_poll=False)
            if value.get('stage') in {'stopped', 'stop_incomplete_requires_review'}:
                value['authenticated_poll'] = False
            stages={'starting','listeners_ready','online','control_plane_degraded','stop_requested','child_start_failed','listener_timeout','child_stopped','unexpected_health_origin','poll_not_observed','runtime_failed','stopped','stop_incomplete_requires_review','state_stale'}
            if value.get('stage') not in stages or not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z',value.get('time','')): raise ValueError()
            out={k:value[k] for k in ('time','stage','state_age_seconds')}
            if value.get('operation') in {'readiness', 'live'}: out['operation'] = value['operation']
            for key in ('authenticated_poll','provider_delivery_verified','children_stopped','forced_shutdown'):
                if type(value.get(key)) is bool: out[key]=value[key]
            channels=value.get('selected_channels')
            if isinstance(channels,list) and channels and all(v in CHANNELS for v in channels) and len(channels)<=2 and len(set(channels))==len(channels): out['selected_channels']=channels
            print(json.dumps(out))
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            print('{"stage":"no_recorded_live_state"}')
        return 0
    if args.stop:
        if LOCK.exists():
            try:
                if sys.platform == 'win32': windows_runtime().win.write_new(str(STOP), b'stop\n')
                else:
                    fd = os.open(STOP, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                    os.write(fd, b'stop\n'); os.close(fd)
            except FileExistsError:
                pass
            except OSError:
                print('{"stage":"stop_request_failed"}'); return 1
            print('{"stage":"stop_requested_wait_for_stopped_state"}')
        else:
            print('{"stage":"no_stack_lock"}')
        return 0
    if not readiness and not args.config:
        print('{"stage":"explicit_plan_and_runtime_confirmation_required"}')
        return 1
    try:
        plan = {'channels': []} if readiness else load_plan(args.config)
    except PlanError:
        print('{"stage":"invalid_nonsecret_plan"}')
        return 1
    if args.validate_plan:
        print(json.dumps({'plan_valid': True, 'selected_channels': plan['channels'], 'credentials_read': False,
                          'network_checked': False, 'runtime_started': False}))
        return 0
    return run(plan, approved=True, readiness=readiness, check=args.check)


if __name__ == '__main__':
    raise SystemExit(main())
