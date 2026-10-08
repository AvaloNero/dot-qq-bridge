# Private QQ + Lark MCP tunnel router

One loopback MCP endpoint for the official tunnelclient's single global
`mcp.extra_headers` map. **Readiness is the default.** The additional live routing
mode is explicit, channel-scoped and implemented/tested offline. This code alone
is not a verified working unified bot or permission to start real message traffic.
It does not launch QQ/Lark processes, own provider connections or contact callbacks.

## Security and scope

- Linux or native Windows NTFS. The deployed sibling stack uses Node 24.15+ in
  major 24; Windows additionally uses an existing Python 3 interpreter and the
  sibling [private-file platform layer](../dot-bridge-platform/README.md).
- Three independent service credentials: aggregate ingress, QQ upstream, Lark
  upstream. File paths **and credential contents** must differ. Provider secrets,
  OAuth tokens, client identity claims and provider IDs are never used.
- Every caller possessing the private Tunnel Use authority has the same pinned
  local owner authority, `tunnel-owner:dot-bridge`. This is not ChatGPT user identity
  attestation or an independently audited ACL boundary. Operator owner-only ACL
  attestation is an operator assertion, not an independent audit.
- Each person must self-deploy their own bridge, own Tunnel and own independent
  credentials. Do not share this owner's Tunnel/key or expose the listener publicly.
- Ingress listens on configured `127.0.0.1` (default) or `::1` only. Upstreams always
  use literal `127.0.0.1`, startup-validated distinct TCP ports and fixed `/mcp`.
  Caller URLs, hostnames, commands, headers and ports never select upstream routes.
  Live-only callback URLs are validated protocol parameters sent only to a fixed
  local backend, never network destinations for this router. No redirect or
  environment-proxy handling is performed; the
  fixed loopback requests use core `node:http` with `agent: false`.
- Each credential must be in an owner-owned 0700 directory, in an owner-owned
  0600 regular single-link file. Symlink path components are rejected. The ingress
  and QQ keys must be exactly 43 canonical base64url characters encoding 32 bytes;
  only the Lark file may additionally have one final LF, matching that bridge.
  Values are read only for intended authentication, never printed or returned.
- No access/request/body logs or durable storage. Startup/shutdown errors are
  fixed text. The program itself writes no log files. Any external supervisor or
  hosted service has separate actual retention rules; no deletion guarantee is
  made for their logs.
- Original raw/parsed Host, Origin and critical HTTP/MCP mirrors are validated
  before filtering. Duplicate critical headers and raw/parsed mismatches fail
  closed. Host must be an allowed loopback name; Origin remains forbidden.
- Authentication uses only the actual loopback peer and one canonical service key
  whose original raw and parsed values agree and match the independent ingress
  credential. Caller identity/context/proxy/bearer/cookie claims cannot substitute
  for that key or select a different principal. All successful callers have the
  same fixed local owner. Missing, wrong, duplicate or inconsistent keys fail.
- Only after these checks, a positive header filter retains Host, Origin,
  Content-Type/Length/Encoding, Transfer-Encoding, Accept, MCP-Method/Name,
  MCP-Protocol-Version and MCP-Session-Id. All other caller fields, including the
  already-verified service key and identity claims, are physically discarded from
  both header representations. No caller claims are interpreted or sent upstream.
- Original MCP `2026-07-28` metadata, header/body matching, encoded name and Accept
  validation is preserved unchanged from the existing QQ/Lark server validators.
  This program does not relax protocol checks for client compatibility.

## Default readiness surface

- `server/discover`, `tools/list`, `events/list` (always empty), `ping`
- `tools/call`, name `check_bridge_setup`, arguments `{}`: validates QQ discovery,
  setup-only tool catalog and empty events, then calls QQ's fixed setup tool. It
  returns only allowlisted setting names/enums and false readiness fields.
- `tools/call`, name `check_lark_readiness`, arguments `{}`: validates authenticated
  Lark discovery plus empty tool/event catalogs. It reports reachability separately
  from provider readiness; delivery and end-to-end verification remain false.
- Valid `notifications/cancelled` is an acknowledged local no-op, never forwarded.
- All other methods/tools and all nonempty tool arguments are rejected. A changed
  or paginated upstream catalog fails closed. No upstream text, metadata,
  identity, response headers, raw errors or next-step instructions are forwarded.
- Unauthenticated `GET /healthz` returns only fixed process-health constants.
  `GET /readyz` always returns 503 and fixed false delivery/verification fields.
  They do not contact an upstream. There is no public OAuth, provider webhook or
  SSE endpoint.

## Local startup after credentials are separately approved and provisioned

Do not generate credentials from this project or put values in environment
variables, command lines, README examples or configuration committed to source.
Run the following from `dot-qq-bridge/packages/dot-bridge-tunnel`. The following
are placeholder path references only:

```sh
AUTH_MODE=tunnel-service \
BRIDGE_MODE=tunnel \
TUNNEL_SERVICE_OWNER_ID=tunnel-owner:dot-bridge \
TUNNEL_SERVICE_READINESS_ONLY=true \
HOST=127.0.0.1 PORT=8789 \
TUNNEL_SERVICE_KEY_FILE=/absolute/private/aggregate-service-key \
QQ_SERVICE_KEY_FILE=/absolute/private/qq-service-key \
LARK_SERVICE_KEY_FILE=/absolute/private/lark-service-key \
QQ_MCP_PORT=8787 LARK_MCP_PORT=8788 \
node src/main.js
```

Run existing QQ and Lark **readiness-only** entrypoints on the corresponding
loopback ports, with transport disabled and empty in-memory stores. Do not use
live bot entrypoints, provider credentials or existing message databases. This
aggregator does not launch/manage those upstream processes. A separate supervisor
may own the three processes and handle shutdown.

`SIGINT`/`SIGTERM` stops accepting requests and destroys in-flight local requests
and open sockets. Resource limits: 8 simultaneous authenticated requests, 120 per
minute, 32 open ingress connections, 8 KiB HTTP headers, 32 KiB request/response
bodies, 5-second body deadline and 3-second deadline per ordinary upstream call.
Readiness QQ checks make four bounded local requests; Lark checks make three.
The synchronous owner `reply_to_lark` call has a 30-second upstream deadline:
its token request and reply acknowledgement can each consume up to 10 seconds.
Other read/catalog calls retain their 3-second limit. The candidate backend uses
the same reply-specific response budget and finishes its HTTP response before
resource cleanup. Message/subscription expiry still limits authorization. A
missing acknowledgement remains unknown, is never projected as sent, and causes
no automatic retry; a backend uncertain result remains uncertain.

Live subscriptions have a 35-second local request deadline to accommodate the
backend's bounded callback verification; live ingress has a 60-second idle limit.
A mutation with an unavailable/malformed/timed-out result may already have committed.
The router never retries it automatically. Backend idempotency and read-only status
checks must be used before deciding whether any follow-up action is appropriate.

## One official hosted tunnel profile

Configure **one** official tunnelclient MCP target as `http://127.0.0.1:8789/mcp`.
Its single global `mcp.extra_headers` entry must reference **only the aggregate
service key file** under `X-Dot-Bridge-Service-Key`, using the official client's
supported file-value syntax. QQ/Lark keys belong only in the local aggregate
process's file-path configuration above. Do not add two client MCP targets with a
shared header, copy raw key values into profiles, or run two main-channel clients.

The verified file-reference shape is:

```yaml
config_version: 1
control_plane:
  api_key: file:/absolute/private/runtime-api-key
  tunnel_id: REPLACE_WITH_YOUR_OWN_TUNNEL_ID
  poll_channels: [main]
mcp:
  server_urls:
    - channel: main
      url: http://127.0.0.1:8789/mcp
  extra_headers:
    X-Dot-Bridge-Service-Key: file:/absolute/private/aggregate-service-key
```

This is a profile fragment, not a substitute for other required settings in an
already verified official-client profile. Use existing separately authorized
runtime credentials; this project never provisions or broadens their access.

Use the official client's verified hosted profile and polling command. This
project does not modify Tunnel ACLs, acquire new persistent credentials, create
plugins, start the hosted client, or change any control-plane configuration.
Discovery/tool checks do not certify current/future Tunnel ACLs or actual provider
delivery. A successful readiness check never enables live routing.

## Explicit live routing (offline implementation; activation requires approval)

- `TUNNEL_SERVICE_OPERATION=readiness|live` defaults to `readiness`.
- `TUNNEL_LIVE_CHANNELS=qq`, `lark` or `qq,lark` is required for live operation.
  Duplicates, unknown names, whitespace variants and an empty live subset fail.
  Readiness rejects any nonempty live subset. The copied subset is frozen.
- CLI live startup additionally requires `--confirm-live`. Library construction
  requires `{approvedLive:true}` for both `createApp` and `createUpstreamClient`,
  checked before credential reads/requests. These are operator assertions, not
  owner approval, identity attestation or permission to expand access.
- Keep the three separately approved service-key file references. No provider or
  storage credential belongs in the aggregate configuration. Enable each selected
  backend's own explicit live mode only after its separate real binding, storage,
  delivery and credential use are approved. Every disabled backend must continue
  to expose its readiness-only catalog; a contradictory live catalog fails closed.
- Use a single existing tunnel target. Do not create a second main-channel client,
  a new plugin, a new key or a broader ACL as part of this routing change.

Exact externally exposed live tools are `get_qq_message` / `reply_to_qq` for QQ,
`get_lark_message` / `reply_to_lark` for Lark, plus the existing two setup tools.
Reads accept only `message_id`. Replies accept only `message_id` and bounded
plain-text `text`. No recipient, owner, provider identity, URL or header is an
input. Tool names determine the channel even when message IDs are identical.
Provider message text is untrusted data; it does not authorize actions. A pending
reply means queued, not delivered. Raw backend error strings are replaced with
fixed categories, and unexpected identity/response fields fail projection.

Live events are exactly `qq.message.created` and `lark.message.created` for enabled
channels. Subscribe/unsubscribe arguments must be `{conversation:"owner"}`.
Delivery is webhook-only with a structurally valid HTTPS DNS-host URL on port443,
no embedded credentials or fragment. Subscribe additionally requires the existing
canonical `whsec_` signing secret (24–64 bytes); it is never generated, logged or
returned by this router. Only null/absent cursors are supported; positive `ttlMs`
is bounded to seven days. The selected backend applies its own smaller lease and
service-principal limit. Returned expiry is preserved exactly; this router owns
no subscription lease and never extends one. Identical URLs on different events
still route, renew and unsubscribe only their selected backend.

Before each live action the selected backend's discovery and exact tool/event
schemas are checked anew, including no pagination. Aggregate live catalogs check
both backend modes and use owned static definitions, never backend instructions.
The router never sends a callback challenge itself. Each backend retains exact
callback-host approval, public DNS/address pinning, TLS/challenge verification,
subscription ownership, expiry and provider lifecycle enforcement.

### Pending callback policy and reviewable preflight

An owner-bound live backend may publish its real event catalog while its callback
allowlist is empty. It must not challenge a URL, connect a gateway or deliver until
its own prerequisites and approved subscription are satisfied. Obtain the actual
callback hostname from the current dot's formal subscription flow; never guess it,
copy a Sites callback or automatically approve it.

`check_bridge_setup` accepts an optional structurally validated `callback_url`
only when QQ live is enabled. `check_lark_readiness` does the same only when Lark
live is enabled, mapped internally to the fixed Lark `check_lark_setup` tool.
These pure local checks return only the supplied hostname, policy enums and
configuration booleans, never path/query/secret, and do not resolve DNS or approve
anything. They also return `callback_transport`, a closed configuration-status
object shared with the production sender. `ready` means the code dependency is
configured for an attempt, not that a connection or managed proxy guarantee was
verified. `network_checked` remains false. A missing supported managed adapter is
reported explicitly; an existing subscription does not make that dependency ready.

For the explicit owner-message experiment, the same authenticated
`check_lark_readiness` call may additionally return `pending_message` containing
only the single delivered, unclaimed message's `message_id` and `reply_deadline`,
or null. Use the existing `get_lark_message` tool to read that message. This
read does not claim it or send a reply. Ordinary readiness output is unchanged.
Extra metadata fields are rejected; expired references become null. The exact
older six-field Lark preflight catalog remains compatible. No message list,
unauthenticated endpoint, callback body, or provider identity is exposed.

A subscription error may expose `callback_policy_required` and a hostname that
matches the validated caller URL, or an allowlisted callback-transport reason and
its strictly validated status object. Other backend error data and exception text
are dropped. Transport errors contain no proxy endpoint, callback path or secret.
Stop for specific hostname approval, then configure the exact backend allowlist
through the separately authorized setup workflow. Configuration and authenticated
local reachability still do not prove provider connection or end-to-end delivery.

### Shared callback dependency

Use two sibling clones with these exact repository directory names:

```text
deployment-root/
  dot-qq-bridge/
    packages/
      dot-bridge-transport/
      dot-bridge-tunnel/
  dot-lark-bridge/
```

The aggregate entrypoint from the QQ root is
`node packages/dot-bridge-tunnel/src/main.js`; the shared module is
`packages/dot-bridge-transport/index.js`. Aggregate and transport must remain
adjacent packages. Lark imports the single transport copy in the sibling QQ
checkout. No top-level transport/aggregate clone, diagnostic publisher, logs or
runtime credentials are included. Each person deploys their own repositories,
Tunnel and private credentials. The packages have no third-party dependencies;
full QQ/Lark integration requires Node 24.15–24.x and each backend's pinned
dependencies, installed through its separately approved setup workflow.

The production callback route is explicitly selected by backend code and cannot
be selected by a caller-supplied destination or header. Managed-proxy selection
does not fall through to the old direct requester. The shared package contains no
unapproved real IP CONNECT implementation. A future supported managed adapter is
a reviewed code dependency, never an environment flag claiming that policy has
been verified. Domain authorization and final public-target/TLS guarantees remain
requirements for that adapter; its presence alone is not independent proof.

## Verification

```sh
node --test
```

Alternatively, from the QQ root run
`node --test packages/dot-bridge-tunnel/test/*.test.js` and
`node --test packages/dot-bridge-transport/test/*.test.js`. The source-copy test
checks all copied files against `../source-copies.json`, including original
source hashes. Runtime sources, package metadata and unchanged tests are exact
copies. These READMEs and the sibling-contract lookup were adapted for the
repository layout; the shared package also preserves extracted pure transport
regressions, with their original source hash and adaptation recorded. Update the
manifest deliberately when modifying a packaged copy after this snapshot. No
temporary publisher, server, CLI or deployment code is bundled.

Tests use public deterministic synthetic keys in fresh temporary 0700 directories
and temporary loopback servers. They never load deployed credentials, contact
providers/callbacks, start real bots or start a hosted runtime. All temporary test processes,
listeners and files are cleaned up. Test groups include strict auth/protocol,
credential isolation, unsafe files, catalog restrictions, hostile responses,
redaction, transport limits, timeout and process shutdown.

When the enclosing `dot-qq-bridge` and its sibling `dot-lark-bridge` source trees
are present in the layout above,
the suite additionally exercises their actual readiness and live/pending-policy
contracts with synthetic credential fixtures. Readiness uses in-memory stores;
live fixtures use fresh temporary stores, disabled workers and blocked external
request functions. It asserts zero provider/challenge/gateway calls and compares
the original protocol validator byte-for-byte. Compatibility groups are skipped
if sibling source trees are absent; standalone fake-upstream tests still run.
