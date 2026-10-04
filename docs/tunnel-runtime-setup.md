# Secure MCP Tunnel runtime setup

This is a reusable deployment guide. It contains no deployment-specific Tunnel
ID, organization/workspace identity, provider AppID, credential or private
filesystem destination. Repository templates are placeholders and are not usable
runtime configuration until the operator supplies their own approved values.

## Repository layout

For QQ alone, clone this repository and retain its bundled packages:

```text
parent-directory/
  dot-qq-bridge/
    src/
    packages/dot-bridge-transport/
    packages/dot-bridge-tunnel/
```

For the optional two-channel aggregate, clone `dot-lark-bridge` beside
`dot-qq-bridge` under the same parent directory. The shared callback transport and
aggregate entrypoint are bundled in the QQ repository; no third sibling checkout
or machine-specific workspace path is required. See the root handoff guide and
`packages/dot-bridge-tunnel` for the aggregate configuration.

## Authentication boundary

The official Tunnel client requires its own restricted runtime API credential
with the permissions needed for the selected Tunnel. This credential is distinct
from each backend's dedicated service key and from the aggregate service key.
Never reuse an OpenAI runtime/API key as a downstream service password.

Private service authentication does not identify a ChatGPT user. Every holder of
Tunnel Use has the fixed local service owner's authority. Verify that the chosen
Tunnel and its organization/workspace access match the intended single-owner
boundary before enabling live traffic. A local service owner label is neither an
OAuth subject nor a QQ openid. If multi-user access is required, use an explicitly
reviewed identity/authentication design instead of sharing this private mode.

The original OAuth alternative remains available. Tunnel transport itself does
not provide the OAuth issuer, JWKS, audience or owner subject required by that
alternative. Do not insert guessed platform identity headers or expose dev auth.

## Secret storage and templates

The `config/` YAML files contain only example loopback addresses and placeholders:

- `tunnel-client.template.yaml`: runtime key supplied through an environment
  reference; this does not grant permission to expose it in a shell or log.
- `tunnel-client.file-key.template.yaml`: runtime key supplied through a file
  reference under an operator-selected private directory.
- `tunnel-service.readiness.yaml`: one QQ readiness backend with its independent
  service-key file reference.

Replace `REPLACE_WITH_YOUR_TUNNEL_ID` and `/ABSOLUTE/PRIVATE_DIRECTORY` only in a
private runtime copy outside the repository. The examples do not create keys or
verify access. Keep private configuration and credential files out of Git.

Use an approved secure user-input or secret-management flow. Do not place secrets
in chat, screenshots, source code, command arguments, raw request logging or
committed configuration. Private secret files must be owned by the runtime user,
mode 0600, under a mode 0700 private directory. The backend readers reject
symlinks, hardlinks, unsafe ownership and permissions. Filesystem permissions do
not imply whole-disk encryption. Any new persistent key or grant requires the
applicable action-time approval.

These profiles target the reviewed official v0.0.15 configuration format. Before
using another release, review its schema and verify the official artifact and
checksum through the supported release process; merely copying a template is
not runtime acceptance. Preserve the environment's approved proxy/TLS setup.
Do not suppress certificate checks or silently change egress routes.

Official references:

- https://github.com/openai/tunnel-client/blob/v0.0.15/docs/configuration.md
- https://github.com/openai/tunnel-client/blob/v0.0.15/docs/permissions.md
- https://github.com/openai/tunnel-client/blob/v0.0.15/docs/troubleshooting.md
- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels

## Readiness operation

The backend defaults to `TUNNEL_SERVICE_OPERATION=readiness`. A private readiness
listener requires only these non-secret settings and the approved key reference:

```text
AUTH_MODE=tunnel-service
BRIDGE_MODE=tunnel
TUNNEL_SERVICE_OPERATION=readiness
HOST=127.0.0.1
PORT=3101
QQ_TRANSPORT=disabled
TUNNEL_SERVICE_OWNER_ID=tunnel-owner:dot-bridge
TUNNEL_SERVICE_KEY_FILE=/ABSOLUTE/PRIVATE_DIRECTORY/tunnel/qq-service-key
```

After the selected runtime operation has been authorized, the readiness entry is
`node scripts/run-tunnel-readiness.js`. It uses an empty in-memory database and
an ephemeral in-memory storage key. It rejects persistent database/storage
settings, provider credentials, owner binding and callback policy. Only discovery,
empty Events catalog, `check_bridge_setup` and ping are available. Subscriptions,
message reads/replies and queue/Gateway activity stay disabled. `/readyz=503` is
expected and must not be relabeled as actual messaging readiness.

Do not run competing main-channel Tunnel clients. The direct QQ profile is for
one backend; the aggregate uses one client and routes its fixed channel tools
internally. Follow the aggregate package's explicit channel selection rules.

## Live operation and callback egress

Read [tunnel-live.md](tunnel-live.md) before selecting
`TUNNEL_SERVICE_OPERATION=live`. It requires approved file-backed provider and
storage credentials, a verified official QR owner, private persistent storage,
the shared mode lock and explicit activation confirmation. Readiness configuration
cannot be promoted by flipping its old boolean flag.

The QR persistence helper is plan-only by default. It requires an explicitly
approved `QQ_APP_ID` and absolute `QQ_CREDENTIAL_DIRECTORY`; it writes only
`${QQ_CREDENTIAL_DIRECTORY}/credentials.json` after the existing scan, owner and
persistence confirmations. Neither identity nor path is inferred from this repo.

An empty callback allowlist remains a safe discovery state. An allowlisted
callback without a supported transport remains `pending_callback_transport`.
The bundled shared transport rejects managed-proxy egress before DNS/request
creation when no supported adapter exists; it never silently falls back to direct
networking. Its `network_checked:false` status and synthetic adapter tests do not
prove real platform callback delivery. See [cloud-proxy.md](cloud-proxy.md).

## Acceptance and cleanup

Treat these as separate checks: local schema/loopback tests; Tunnel Read/Use;
current-dot tool discovery; authenticated Events subscription and signed callback
verification; provider connection; one verified owner message/reply; and restart
without duplicate delivery. A successful earlier stage does not establish a later
one. Local offline tests do not claim any deployment or production connection.

After an authorized bounded check, stop the client and test listeners, verify that
no competing consumer remains and remove only that check's temporary files. Use
the documented retention limits for logs; do not promise physical secure erasure.
For credential revocation, stop and restart any process that cached the old value.
