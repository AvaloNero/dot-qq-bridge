# Explicit bridge modes (offline integration)

`BRIDGE_MODE=tunnel|sites` is required by the formal entry. There is no fallback.
Both modes use one approved `BRIDGE_LOCK_DIRECTORY` on this cloud computer.
The lock key is SHA-256(channel + ':' + AppID), independent of mode and DB path.
An existing lock blocks a second instance. Crash recovery is explicit, never an
automatic stale-lock takeover. This guards one machine; it is not a global
cross-machine lock or permission to run a second host. SQLite records its mode
and refuses mode changes or adoption of an unlabelled legacy DB into Sites mode.

## tunnel

Existing Node `/mcp`, OAuth resource authentication, direct Events callbacks and
QQ Gateway. Secure MCP Tunnel supplies approved ingress separately. Keep
`AUTH_MODE=oauth`. Tunnel account/runtime authorization is not configured here.

## sites

Keep QQ AppID/secret and owner openid in the local approved runtime only.
`AUTH_MODE=sites` is a separate connector mode, not a publicly accepted bearer
mode and not a way to start a Node MCP endpoint without OAuth. Node opens no HTTP
listener in this mode. It uses the fixed outbound queue contract below; the Site
owns authenticated MCP, Events subscriptions and inbox/outbox records.

Configuration: `SITES_ORIGIN`, `SITES_BINDING_ID`, `SITES_SERVICE_CREDENTIAL`,
`SITES_CONNECTOR_CREDENTIAL`, plus existing local QQ/storage settings. The
configured `MCP_OWNER_SUBJECT` is the explicit local binding namespace, not a
caller-supplied or inferred ChatGPT identity. Sites must bind that opaque channel
binding to its separately authenticated owner. Real secrets are never examples.

Transport uses the existing DNS/public-IP/pinned TLS requester, exact approved
origin and relative route constants. It does not relax callback pinning or reuse
the QQ provider proxy. Both headers are required: platform-consumed
`OAI-Sites-Authorization: Bearer ...` and app-validated per-binding
`Authorization: Bearer ...`. Neither is a ChatGPT user's identity.

## Worker contract v1

All requests POST JSON, include `binding_id`, and except lease include
`lease_token`. Responses are HTTP 200 or fail closed; no redirect following.

- `/bridge/lease`: instance_id → binding_id, channel, mode='sites',
  subscription_id, lease_token, expires_at, subscription_active=true. Maximum
  90 seconds; renew every 30 seconds. No actual active dot subscription => reject.
- `/bridge/inbox`: subscription_id, message_id, event_id, text, occurred_at,
  reply_deadline → matching message_id and accepted|duplicate.
- `/bridge/outbox/claim`: → job=null or message_id, text, reply_deadline,
  subscription_id, claim_token, claim_expires_at (maximum 60 seconds and no later
  than the binding lease). One-shot claim, not repeated delivery each poll.
- `/bridge/outbox/ack`: message_id, claim_token, sent|uncertain|dead → matching
  terminal receipt. Same-token same-terminal ACK is idempotent while still valid.

Node receives QQ messages only while a valid authenticated remote subscription
lease is present. The local DB mirrors its identity for FK references; that row
alone never authorizes Gateway and is disabled on restart. Claims are encrypted
and retained durably across unrelated queue work/restarts. A send must still be
inside its claim and original passive-reply deadline. Ambiguous sends become
uncertain and are never blindly sent again. Only pending ACKs retry. If a claim
expires after a send but before acknowledgement, the Site may remain uncertain;
that is preferable to duplicate delivery. Local text and claim retention is pruned.

## State and verification

Both paths are implemented for offline tests, not deployed or authenticated live
integrations. Sharing is a later objective, not public publication approval.
Sites must first demonstrate a synthetic event reaching the current dot, correct
owner/binding separation, revoked/expired lease rejection and response receipts.
No scan or real message is needed to test this contract. Only then configure the
chosen runtime with separately approved credentials; do not run both modes for
the same channel/AppID simultaneously.
