# Formal persistent QQ service (direct MCP contract)

This entry runs the existing Node bridge continuously. It does not perform a short
scan/test and discard configuration. It requires an operator-approved source of
configuration; it never loads `.env`, obtains new credentials, or writes secrets.
The explicit Tunnel live configuration reads approved private credential and
storage-key file references into memory.
No real service was launched while developing this entry.

- `node scripts/qq-service.js --plan`: no configuration read, network or storage.
- `node scripts/qq-service.js --check-config`: inspect already-authorized environment
  configuration; emit only missing/invalid setting names and boolean readiness.
- `node scripts/qq-service.js --run --confirm-persistent-service`: only after the
  runtime, ongoing credential use, persistent storage and service operation have
  been explicitly authorized. The flag records the intended mode, not a substitute
  for obtaining that authorization.

The runtime supports OAuth, the existing Sites adapter, or the explicitly selected
private Tunnel live operation documented in [tunnel-live.md](tunnel-live.md).
It requires Gateway transport and a configured disk
SQLite path/storage key. It exits before creating the app, database or listener
when required configuration is missing. No developer bearer fallback is permitted.
A callback allowlist may initially be empty so the authenticated operator can
complete the existing callback-host discovery/approval procedure. Empty allowlist
cannot yield a valid active subscription or an active QQ Gateway.

The existing Gateway waits for an authenticated active subscription, checks it
again before connecting and while processing messages, and disconnects when it
expires. Restart/resume, leasing and deduplication remain in the existing durable
store. The service itself does not create subscriptions or authorize replies.

## Logs and status

JSON stdout reports startup/shutdown, coarse configuration/subscription/Gateway
stages and an allowlisted Gateway phase. It logs changes and a 60-second heartbeat,
not incoming text, owner IDs, access tokens, callback URLs, request/response bodies
or raw exceptions. No new public status endpoint is introduced. `/healthz` and
`/readyz` retain their existing minimal contracts. Log persistence/rotation belongs
to the specifically approved supervisor, not this script.

`ready_for_owner_message` means configured + active authenticated subscription +
Gateway connection. It does not prove current-dot receipt or an end-to-end reply.
`current_dot_roundtrip_verified:false` is deliberately not promoted automatically;
actual acceptance is an owner message answered by the current dot with matching
message identity and no duplicate on restart.

SIGTERM/SIGINT perform graceful shutdown once. A real persistent supervisor and
persistent volume remain necessary for restart/24-hour service guarantees; merely
starting this command in an execution session does not establish them.

## Deployment contracts

The approved private single-owner Tunnel route now has an offline live-mode
implementation. Its file-only credential/storage contract, cold-start callback
policy gate and remaining real activation approvals are in
[tunnel-live.md](tunnel-live.md). Default readiness is preserved. The original
OAuth and Sites paths remain available without silently switching modes.

The OAuth alternative uses the existing authenticated Node `/mcp` resource server
and its issuer/JWKS contract; Tunnel transport itself does not supply that issuer.
The separate existing Sites adapter uses its authenticated lease and durable
claim/receipt flow. None is silently activated here. Establish the selected MCP
endpoint/authentication, then approve ongoing QQ credential access and storage
for that runtime. No new scan is needed merely to inspect or prepare the code.
