# Portable QQ / Lark tunnel stack

These launchers package the existing private supervisor with explicit external
runtime locations. Copying or cloning the projects does **not** migrate any
credential, provider binding, message database, tunnel binary, logs or state.
The examples contain placeholders only. No key is created or read by the default
plan or validation commands; the activated child services read their configured
files for authentication. A CLI confirmation flag is an operator assertion, not
a replacement for the owner's authorization.

## Platform and source layout

Linux uses `/proc`, `fcntl`, owned 0700 directories and 0600 files. Native Windows
uses local fixed NTFS drives, owner/SYSTEM-only DACLs, descriptor-relative Win32/NT
opens, `LockFileEx`, and a private Job Object. It does not emulate Unix permissions
with `chmod`. UNC/device/ADS paths, reparse points and hardlinked private files are
refused. Other platforms fail closed with `supported_runtime_required`.

Both require existing Python 3.10+ and Node 24.15+ within major 24. Windows uses the
supervisor's existing interpreter for the Node private-file helper; standalone
bridge tools can select that same trusted interpreter with `DOT_BRIDGE_PYTHON`.
No interpreter, WSL distribution, binary, certificate or software is installed by
these launchers. Details: [Windows platform boundary](../../packages/dot-bridge-platform/README.md).

```text
any-parent-directory/
  dot-qq-bridge/
    tools/tunnel-stack/live-stack.py
    tools/tunnel-stack/readiness-native-stack.py
    packages/dot-bridge-transport/
    packages/dot-bridge-tunnel/
  dot-lark-bridge/
```

The launcher's own location determines the QQ checkout; Lark is its sibling.
The current working directory does not select source trees. Install each bridge's
dependencies by its normal instructions. The aggregate package is inside the QQ
checkout. No paths from the original cloud workspace are required.

Node is selected by an explicit absolute `--node /path/to/node`, or the fixed
trusted search path `/usr/local/bin:/usr/bin:/bin`. Inherited `PATH`, shell startup
files, `NODE_OPTIONS`, provider-secret environment variables and repository `.env`
files are not forwarded or sourced. If a version manager supplies Node elsewhere,
pass its absolute binary path explicitly. Proxy and CA environment settings are
forwarded through a small allowlist, preserving the existing transport policy;
they are not printed. The child HOME is an external empty directory under state.
On Windows pass `--node 'C:\Program Files\nodejs\node.exe'`; its directory is
the only child PATH entry. Windows additionally receives SystemRoot/WINDIR, a
private USERPROFILE, the selected Python path and the private supervision flag.

The CA allowlist explicitly preserves inherited `SSL_CERT_FILE`, `SSL_CERT_DIR`,
`NODE_EXTRA_CA_CERTS` and `NODE_USE_SYSTEM_CA`. It does not set these values,
install certificates, disable TLS verification or forward `NODE_OPTIONS`.

## Non-secret external configuration

Copy `runtime-config.example.json`, `live-plan.example.json` (for live mode) and
`tunnel-profile.example.yaml` to an operator-owned configuration directory outside
both repositories. Replace every placeholder. Do not put credential values into
these files. Keep the tunnel profile's two credential settings as file references,
its single `main` target at `http://127.0.0.1:8789/mcp`, and its only service-key
header bound to the aggregate service key. The supervisor passes the profile to
the official client; it does not parse YAML or independently attest its contents.
Review that profile before authorizing a run.

The runtime manifest has exactly four absolute paths:

- `tunnel_client`: separately installed, operator-approved official binary for the selected OS
- `tunnel_profile`: reviewed, non-secret profile outside the repositories
- `private_root`: existing private directory outside the repositories
- `state_root`: common external directory used by **both** launchers

The private and state roots must be distinct and non-overlapping; profile and
binary locations must be outside both roots. Source-repository destinations,
relative paths and `..` components are rejected. Runtime directories must be
owner-owned mode 0700 on Linux, or protected owner/SYSTEM-only DACLs on Windows.
Create the state root's parent beforehand; an authorized
run may create the state root and its empty HOME. Metadata uses owner-only 0600
single-link regular files and rejects symlinks.
Windows creates private objects with their final DACL, validates existing objects
by handle, and never repairs a deployed ACL. The profile must also reside in an
existing private directory; only metadata is checked by the supervisor. A binary
may grant public read/execute but may not grant write/delete/DACL changes to
untrusted principals. Windows paths in JSON must use escaped backslashes.

Provision these existing authorized credential files separately; no provisioning
or migration command is bundled here:

```text
private_root/tunnel/runtime-api-key
private_root/tunnel/aggregate-service-key
private_root/tunnel/qq-service-key
private_root/tunnel/lark-service-key
```

Provider credentials and storage locations in the live plan must stay within
`private_root/qq/` or `private_root/lark/`; the shared lock-directory reference may
be `private_root/locks`. The bridges also apply their own strict credential-file
checks. The example intentionally fails validation until app IDs are replaced.
To enable only one provider, list only that channel and remove the other provider
object. An empty callback allowlist does not approve any callback hostname or
verify delivery; configure only separately approved exact hostnames.

## Commands

Both default commands are offline plans. They do not read a runtime manifest,
credential files or profile, start processes, create state, or use the network:

```sh
python3 tools/tunnel-stack/live-stack.py
python3 tools/tunnel-stack/readiness-native-stack.py
```

Validate the external configuration and live plan without reading referenced
credential files or starting a runtime:

```sh
python3 tools/tunnel-stack/live-stack.py --validate-plan \
  --runtime-config /absolute/config/runtime.json \
  --config /absolute/config/live-plan.json
python3 tools/tunnel-stack/readiness-native-stack.py --validate-plan \
  --runtime-config /absolute/config/runtime.json
```

Validation checks structure and path scope, not credentials, Node version, tunnel
profile contents, external network access, ACLs or delivery. It reads only the
non-secret JSON configuration(s); path resolution may inspect filesystem metadata.

After separate owner authorization for the intended mode and credential use:

```sh
python3 tools/tunnel-stack/readiness-native-stack.py --check \
  --confirm-readiness-runtime --runtime-config /absolute/config/runtime.json \
  --node /absolute/node24/bin/node
python3 tools/tunnel-stack/readiness-native-stack.py --run \
  --confirm-readiness-runtime --runtime-config /absolute/config/runtime.json \
  --node /absolute/node24/bin/node
python3 tools/tunnel-stack/live-stack.py --run --confirm-live-runtime \
  --runtime-config /absolute/config/runtime.json \
  --config /absolute/config/live-plan.json --node /absolute/node24/bin/node
```

Readiness uses disabled provider transports, readiness-only backends and the
readiness aggregator. It still authenticates to the tunnel control plane.
`--check` stops after one successful authenticated poll. Both `--run` modes stop
after a maximum **30-minute online connection window**; live does not renew or
restart itself. `online` proves an authenticated control-plane poll, not provider
delivery, owner binding, plugin acceptance or end-to-end message success. Historical
cloud acceptance proof is not imported into a new installation.

Use either entrypoint and the **same runtime manifest** to inspect/request stop:

```sh
python3 tools/tunnel-stack/live-stack.py --status --runtime-config /absolute/config/runtime.json
python3 tools/tunnel-stack/live-stack.py --stop --runtime-config /absolute/config/runtime.json
```

The shared state root contains `stack.lock`, `stack.stop`, `stack-state.json` and
`stack-events.jsonl`. Both modes use the same exclusive lease: create-plus-flock
on Linux, atomic create with a retained native handle and LockFileEx on Windows.
The launcher also refuses occupied fixed loopback ports 8787–8789 and an existing
visible `tunnel-client` process (or the configured binary's process name). Keep
one canonical manifest/state root per deployment. Separate machines or isolated
PID/network/filesystem namespaces require operator coordination; this local lease
cannot establish that an old cloud runtime has stopped. Confirm the old runtime's
terminal state before moving the same tunnel authority to another machine.

Stop requests are shared-filesystem markers, not process IDs to signal. The owner
terminates only children it launched, allows a bounded graceful interval and kills
only its own remaining children if necessary. A forced/failed shutdown keeps the
lease and stop marker and reports `stop_incomplete_requires_review`; never delete
them automatically to force a second runtime. A recorded state older than 90
seconds is stale, and a stop-request acknowledgement is not proof of shutdown.
Windows assigns each suspended child to a kill-on-close Job Object before
resuming it. Node children use an inherited private stop pipe; the client has a
fresh hidden console for CTRL_BREAK. Descendants remain in the Job Object. Job
accounting drains for at most two seconds; an incomplete drain is a forced stop.
The 30-minute window and conservative lease retention apply on both platforms.
Listener startup also has a 30-second deadline; configuration failures exit
immediately rather than waiting for a stop request.

Logs retain the latest 1000 fixed-classification events from the current run and
overwrite the previous run on its first event. Provider stdout is projected to
allowlisted enums/booleans; raw stdout, stderr, messages, credentials, identities
and callback addresses are not persisted. These are the supervisor's actual local
retention limits; terminal captures, OS backups and external logs have their own
retention. Temporary health files are removed when the supervisor exits normally.

## Pure offline tests

From the QQ checkout, run:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tools/tunnel-stack -p 'test_*.py' -v
```

The original supervisor tests use auto-cleaned synthetic directories and mocked
process/network calls. Windows integration tests additionally start short-lived
hidden Python children and the three actual readiness entrypoints on temporary
loopback ports, using public synthetic file keys and empty databases. They never
start a Tunnel client or provider, create a real Events subscription, read deployed
credentials, generate persistent keys, or contact external services.
Coverage includes relocation under an arbitrary clone parent, default/gated plans,
outside-repository configuration, environment isolation, shared readiness/live
lease and stop behavior, fixed-port conflicts, log redaction, 30-minute window
termination, and conservative handling of an incomplete shutdown.

On Windows, run with the already installed interpreter:

```powershell
& 'C:\path\to\python.exe' -B -m unittest discover -s tools/tunnel-stack -p 'test_*.py' -v
```

Run these native integration tests as the intended normal Windows user. A sandbox
token that cannot traverse that user's ancestors must fail closed; granting it
access or weakening DACL checks is not a test setup requirement. Linux runtime
regressions must be run separately on Linux; Windows results do not attest them.
