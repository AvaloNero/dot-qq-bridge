# Official QQ scanner in the cloud computer

## Provenance and scope

This project uses the public `startQrConnect` API from exactly
`@tencent-connect/qqbot-connector@1.2.0`. Its npm README documents installation,
callback use and rendering/sending the QR yourself. Tencent's official
[OpenClaw integration](https://github.com/tencent-connect/openclaw-qqbot/blob/main/src/setup/login.ts)
uses the same API. The wrapper repository has an MIT license; the dependency's
npm metadata is `UNLICENSED` and it contains no separate license file.
These facts do not relicense the dependency. This is normal documented package
integration, not copying or redistributing its internals; publication/distribution
of the dependency or a commercial integration needs its own review.
The lockfile pins its registry integrity. Installation used `--ignore-scripts`.

## Consent before an actual scan

No real scan was executed during implementation. Before launch, approve:

1. One official QQ binding session, maximum 120 seconds, initiated from the cloud
   computer. You personally scan and confirm in QQ. QQ returns credentials to the
   isolated scanner process, kept only in memory for this bounded check.
2. Supply the existing bot's non-secret AppID and confirm the scanning QQ account
   is the intended sole owner. The returned AppID must match, and the SDK must
   return that scanning account's `userOpenid`; missing identity fails closed.
3. Optionally approve one token exchange and one Gateway discovery using those
   returned credentials. Select `tencent-sdk`, `tencent-sandbox`, or `documented`;
   no default and no automatic fallback. No WSS or message send follows.

The public SDK does not offer an existing-bot-only parameter or guarantee that
its QQ page cannot create a bot. Inspect the QQ confirmation screen. Cancel if it
proposes creating/replacing a bot or granting anything beyond the approved scope.
A returned-AppID check detects mismatch after scanning, not before QQ's own action.
The SDK API provides no grant-revocation operation; clearing local memory does
not revoke any authorization QQ may create. User confirmation in QQ is required.

## Commands

No network or credentials:

```
node scripts/qq-official-scan.js --plan
```

Only after the specific consent above:

```
node scripts/qq-official-scan.js --scan --confirm-official-scan --confirm-scanner-is-owner --expected-app-id EXISTING_APP_ID
```

Optional separately approved diagnosis adds:
`--confirm-provider-check --profile tencent-sdk` (or the explicitly chosen profile).

Only a validated official QR URL and sanitized status leave the child. Deliver the
QR only to the owner in the approved private conversation; don't send it to a
third-party QR generator. The console never prints AppSecret/access tokens or SDK
errors. SDK console output is disabled and child stdout/stderr are ignored.
Nothing reads `.env`, writes credentials, starts the bridge, binds an owner into
persistent configuration, receives messages or claims current-dot connection.
The returned credentials are discarded after this trial. Ongoing setup requires
specific storage authorization and a separate runtime integration step.

## Network and lifetime

The SDK uses `node:https` without an agent injection option. Only its isolated
child replaces `https.globalAgent`: existing environment proxy, exact `q.qq.com`,
TLS verification, POST to the two observed SDK binding paths only, 65-request
ceiling and 256 KiB response ceiling. This accommodates the pinned SDK's actual
transport, not arbitrary untrusted code; a global agent is not a network sandbox.
No callback/OAuth transport is changed. The SDK treats non-200 responses as errors
and does not follow redirects. QR expiration aborts instead of silently refreshing.
Parent terminates the child after result, cancellation or hard deadline (190s,
including optional 60s diagnosis). SDK in-flight work cannot survive parent
termination of that child. No shell secrets/argv, config file or persistent token.
Same-user process inspection and physical RAM zeroization are not promised.

## Verification limits

Local tests cover consent, origin/query/path restrictions, expected AppID,
scanner-owner evidence, duplicate results, error redaction, abort/timeout, request
budget and response limit. No real QR, QQ login, token exchange, or live Gateway
connection was run. Current-dot ingress, authenticated MCP subscription/callback
transport and durable restart remain separate dependencies.

## Cloud-computer trial update (2026-10-02)

Following explicit user approval and the user's network-access setting change,
one fresh official SDK session completed successfully: expected existing AppID
matched, official scanning-owner identity present, and the separately approved
token exchange plus Gateway discovery passed. The process exited 0 with
`credentials_written:false` and `current_dot_connected:false`. No credentials,
QR payload, owner identifier or token are recorded here. No WSS was opened and
no messages were received/sent. Earlier tool-level egress denials are historical;
this trial observed actual create and poll HTTP 200 responses (one poll timed out
before later successful polls).

The isolated transport now emits allowlisted stage/method/sequence/phase/HTTP
status/elapsed-time/error-code diagnostics only. Parent IPC revalidates and drops
unrecognized fields; it never prints raw errors, response bodies, request bodies,
query strings or credentials. This instrumentation does not alter networking.

## Local waiting limits

The scanner waits locally for at most 600 seconds. This is a client-side waiting
limit, not a claim about the official QQ QR lifetime. An official expiry signal
still ends the attempt immediately; generating another QR requires an explicit
restart. The worker has 15 seconds of cleanup allowance, and the parent adds a
further 5 seconds. An explicitly approved provider check has its separate
60-second budget.

Each QR request has an outer 30-second total bound, using the existing proxy
and TLS settings. This does not override the SDK or proxy timeout: either may
fail earlier, including at the SDK's 10-second limit. Cancellation terminates
outstanding requests. A wall-clock cutoff is
checked again when accepting a successful result and before saving credentials,
so a suspended process cannot save a late response before an overdue timer runs.
An outer supervisor must allow the local waiting window plus cleanup, and must
not label that window as server-side validity.
