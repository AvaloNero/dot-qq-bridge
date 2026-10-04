# Private QQ Tunnel live operation

Implementation status (2026-10-03): prepared and tested offline only. No actual
QQ scan, provider request, bot message, Events task, long-running service,
credential read/generation/persistence, or deployment occurred during this work.
All credential fixtures and queue exercises used synthetic values under `/tmp`.

## Separate readiness and live operations

`AUTH_MODE=tunnel-service` still defaults to
`TUNNEL_SERVICE_OPERATION=readiness`. Its entrypoint
`scripts/run-tunnel-readiness.js` rejects a live operation, provider file
references, storage references and persistent database paths. It runs only the
existing empty in-memory readiness app and never attaches a Gateway or worker.

Formal live service uses `node scripts/qq-service.js --run
--confirm-persistent-service`. With no arguments or `--plan`, it prints an offline
plan without reading files or starting anything. `--check-config` reads only
already-authorized credential/configuration files and emits setting names and
booleans; it does not create a database, lock, listener or network request. These
CLI flags never replace the user's specific authorization for real credential
access/storage, persistent execution, subscriptions or communication.

## File-only live configuration

Required non-secret configuration:

- `AUTH_MODE=tunnel-service`
- `BRIDGE_MODE=tunnel`
- `TUNNEL_SERVICE_OPERATION=live`
- `HOST=127.0.0.1` (or `::1`) and the fixed local QQ backend `PORT`
- `TUNNEL_SERVICE_OWNER_ID=tunnel-owner:dot-bridge`
- `TUNNEL_SERVICE_KEY_FILE`: existing dedicated QQ backend service key
- `QQ_TRANSPORT=gateway`
- `QQ_API_PROFILE=tencent-sdk`
- `QQ_APP_ID`: the explicitly approved existing bot AppID
- `QQ_CREDENTIALS_FILE`: approved official QR credential file
- `STORAGE_KEY_FILE`: separately approved queue encryption key file
- `DATABASE_PATH`: absolute normalized file in an existing private directory
- `BRIDGE_LOCK_DIRECTORY`: existing private shared mode-lock directory used by
  every consumer of the same QQ AppID, including the alternative Sites mode
- `MCP_CALLBACK_ALLOWED_HOSTS`: empty during callback-policy discovery, then only
  the independently reviewed exact official callback hostname(s)

The repository validates the explicitly approved configured AppID against the
credential file rather than hardcoding a deployment's account into the reusable
server. The QR authorization helper must pin that same approved existing app.
The fixed service owner is a local deployment identity, never a QQ
openid or proof of the caller's ChatGPT account. Every Tunnel Use holder has this
service owner's authority; the private single-owner Tunnel boundary must hold.

Both key files contain exactly 43 ASCII base64url characters encoding 32 bytes,
without a newline. Storage and service keys must differ and use independent
files. No code here generates or rotates a production storage key. The storage
loader converts that value to base64 only in memory for the existing AES-GCM
vault. Inline `STORAGE_KEY`, `QQ_BOT_SECRET` and `QQ_OWNER_OPENID` are rejected in
Tunnel live mode, including attempts to override the file-derived owner. Mixed
OAuth, dev and Sites settings are rejected.

The QQ file is the JSON result written exclusively by the approved persistent QR
helper, with exactly these fields: `version:1`, `provider:"qq"`,
`profile:"tencent-sdk"`, `app_id`, `app_secret`, `owner_openid`, and
`owner_evidence:"official-qr-response"`. The scanner derives owner identity from
the official SDK response and rejects absent or mismatched ownership; it never
claims the first message sender. Existing files without that evidence are
refused, not silently rewritten or upgraded. The evidence field records the
trusted provisioning flow; filesystem access controls protect it, and it is not
a provider signature on the JSON file.

`scripts/qq-authorize-persistent.js` remains plan-only by default. Its existing
explicit scan + scanner-owner + persistence flags are required before the SDK
can load or any credential file can be saved. Set the explicitly approved `QQ_APP_ID` and absolute `QQ_CREDENTIAL_DIRECTORY`
in the operator environment. The destination is
`${QQ_CREDENTIAL_DIRECTORY}/credentials.json`; no deployment identity or secret
directory is hardcoded or inferred. Do not execute this helper
until the real scan, receipt and storage scope has been approved. Never supply
real secret values in shell arguments, chat, screenshots or log output.

## Startup and Events contract

Direct app/Bridge construction and the persistent runtime revalidate operation,
file-derived binding and private paths before storage or listener creation.
Live constructors and runtime wrappers additionally require the explicit
`approvedLive:true` option; it defaults to false and rejects before credential
reads or side effects. The confirmed CLI run supplies it internally. That option
records a caller's already-obtained authorization, never obtains it itself.
Readiness cannot become live by merely changing the old readiness boolean. The
loopback peer and strict raw service-key/header checks remain active; arbitrary
caller identity headers are rejected. The aggregator continues reconstructing
the required MCP headers; backend header/body matching was not weakened.

Live mode exposes exactly `get_qq_message(message_id)`,
`reply_to_qq(message_id,text)` and `check_bridge_setup(callback_url?)`. The only
event is `qq.message.created`, with arguments `{ "conversation": "owner" }`.
No tool accepts a recipient, provider routing address or arbitrary channel.
The event's data is `{message_id,conversation,text,reply_deadline}`.

Catalog responses retain `ttlMs:0` and `cacheScope:"private"`. Subscription input
uses the existing `name`, fixed `arguments`, `delivery:{mode:"webhook",url,secret}`,
optional null cursor and `ttlMs`. Successful subscriptions return
`{id,refreshBefore,cursor:null,truncated:false}`. Unsubscribe omits the delivery
secret and returns `{}`. The backend applies signed callback verification,
HTTPS/DNS/IP pinning, exact callback allowlisting, one active subscription and
TTL bounded by both configured subscription lifetime and authenticated service
principal lifetime.

Both the real subscription challenge and queued event delivery explicitly use
the shared callback transport bundled at `packages/dot-bridge-transport`.
An existing managed proxy without a supported callback adapter fails closed
before local DNS or request creation; it never falls back to `agent:false`
direct egress. Provider, OAuth and Sites call paths retain their separate scope.
Keep this repository’s package layout intact. For the optional aggregate bridge,
clone `dot-qq-bridge` and `dot-lark-bridge` beside one another under one parent
directory; the aggregate lives in `packages/dot-bridge-tunnel` of this repository. No environment boolean can assert a
verified proxy contract, and a passing injected-adapter test is not evidence of
real platform callback delivery.

An empty callback allowlist is an allowed cold-start state, reported as
`pending_callback_policy`. Catalog and setup inspection work, but subscription
verification, event delivery and Gateway/provider traffic remain blocked. A
subscription attempt reports only the callback hostname and policy. It never
approves or contacts that host. The actual current-dot callback must be obtained
from the official subscription flow; never guess it or copy a Sites callback.
Even a persisted subscription becomes inactive for execution if its hostname is
removed from the current callback allowlist.

`check_bridge_setup`, configuration preflight and live status also report the
sanitized shared `callback_transport` object. If callback policy is configured
but its production transport is unavailable, the service reports
`pending_callback_transport` and remains unavailable to the Gateway, including
after restarting with a persisted subscription. This listener-side diagnostic
state is not successful proxy implementation or verified Events connectivity.

After a valid current-dot subscription exists, the Gateway can begin its normal
authenticated connection. Revocation/expiry blocks every later incoming event,
message read and queued reply, and stops the Gateway. Subscription generation and
epoch checks prevent unsubscribe-during-verification from reactivating a lease,
and prevent same-ID resubscription from authorizing earlier messages or jobs.
Replies remain bound to the original verified owner, message ID and passive
reply deadline, with durable deduplication and no automatic resend of an
uncertain provider acknowledgement.

## Storage, locks and cleanup

Linux descriptor-relative directory traversal rejects symlink components. Private
leaf directories must be owned by the process user with exact mode 0700; key,
credential, database and existing SQLite sidecar files must be regular files
owned by that user, mode 0600 and link count one. Special files, hardlinks,
symlinks, unsafe permissions, unsafe ownership and oversized credentials fail
closed. The database directory descriptor stays open until SQLite closes, but
SQLite may canonicalize its descriptor-relative filename to a real path. This
does not claim lifetime protection against another process with the same user
identity mutating that directory; same-user processes remain inside the trusted
runtime boundary. Synthetic directory-rename testing observed safe write refusal.

The existing SQLite queue encrypts message text, reply text, callback URL/signing
material and Gateway session fields with AES-GCM. The whole database is not
encrypted: IDs, owner/app/principal binding, timestamps, queue states and durable
deduplication tombstones remain metadata. Text pruning logically clears old
fields after seven days when the worker runs (checked about hourly). It is not
secure erasure or an exact physical disk-retention guarantee. SQLite/WAL,
filesystem backups and supervisor logs follow their separately approved actual
retention limits. No new log retention promise is made here.

The shared mode lock rejects a second QQ consumer for the same AppID regardless
of selected tunnel/Sites mode or database path. Release verifies the original
private lock file and nonce; a failed shutdown or uncertain startup retains the
lock for explicit operator recovery. There is no automatic stale-lock takeover.
SIGINT/SIGTERM stop the Gateway, wait for the worker and listener, close SQLite
and release the lock only after confirmed shutdown. Closed apps cannot reopen.

The live runtime emits fixed lifecycle/status enums, booleans and timestamps.
It never logs credentials, provider identity values, message text, callback
paths/secrets or raw exceptions. `ready_for_owner_message` proves only configured
service + current subscription + Gateway connection; it does not claim a real
current-dot roundtrip.

## Remaining real-world approval and acceptance

Before activation, obtain the user's approval for any new persistent storage key
generation and the precise storage destination; official QQ scan/credential
receipt and persistence; approved runtime service operation; current-dot Events
subscription and callback/signing credential persistence; and bounded same-owner
message forwarding/replies. New grants, expanded persistent access or credentials
remain subject to action-time approval. No request to prepare this code alone
authorizes those actions. A real acceptance pass must then verify one current-dot
Events subscription, one owner message/reply, and restart without a duplicate.

Offline verification: `npm test` and `npm run check`. The regression suite covers
readiness isolation, private file protections, explicit file-only live gates,
direct-library safeguards, pending callback policy, authenticated synthetic
Gateway/Events/reply delivery, TTL, duplicate suppression, revocation races,
changed callback policy on restart, encryption-key mismatch, mode-lock exclusion,
worker operation and graceful shutdown/reopen refusal. OAuth/Sites regressions
remain included.
