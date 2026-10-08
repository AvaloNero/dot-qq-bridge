# QQ owner single-message opt-in

This entry is separate from the ordinary service. It receives one ordinary text
message from the already verified scanning owner, delivers the existing signed
MCP event, and permits one fixed passive reply. It never performs QR authorization
or provisions credentials. Caller approval is required for the live scope and
private encrypted message storage.

Import `startQqOwnerMessage` from `src/owner-message-runtime.js`. Pass the result
of the existing `readConfig(env)` and options:

```js
{
  approvedSingleMessage: true,
  acceptAnyOwnerText: true,
  waitForOwner: true,
  fixedReply: 'the approved fixed reply',
  proxyEnv: env,
  report: safeStatusHandler,
  signal: optionalAbortSignal
}
```

The result exposes `status()`, `close()` and `closed`. There is no arbitrary
five-minute owner-wait cutoff. An authenticated subscription and its actual lease
are still required before QQ Gateway access. Only the same callback URL and
signing-secret grant may renew before the owner message is selected. Receipt of
the one message arms its existing timestamp-based QQ passive-reply expiry; a
renewal never extends that message's lifetime. User stop or a terminal result
closes the runtime.

`gateway_ready` requires the existing QQ Gateway adapter's `connected` phase,
which follows QQ `READY` or `RESUMED`, not merely a TCP/WebSocket connection.
`reply_to_qq` preserves the normal asynchronous queue response. A `pending`
result is not a delivery acknowledgement. The safe terminal event follows the
Store's actual reply acknowledgement or terminal job outcome, then selected-body
cleanup, then shutdown. `provider_acknowledged` and `bodies_cleared` are separate
booleans so a cleanup failure cannot hide an acknowledged provider send.

Only `check_bridge_setup` in this opt-in adds optional `pending_message` with
the authenticated current subscription's selected `message_id` and
`reply_deadline`. It never exposes another owner's message, credentials or the
callback URL. The aggregate must support this exact optional schema.

The Store persists the one-attempt budget before provider I/O. No unknown result
is automatically retried. Input and fixed-reply text are encrypted with the
separately approved local storage key; normal logs contain neither. Terminal
cleanup nulls only the selected message/reply text fields, retaining receipt,
deduplication and budget metadata. This is logical database cleanup, not a claim
of forensic erasure of prior encrypted SQLite pages or platform logs.

An existing database may be reused only when its original encrypted budget is
exactly `waiting`, has no selected message, reply deadline or attempt, and matches
the same fixed reply. Subscriptions, messages, replies, jobs, gateway leases,
replays and subscription/gateway checkpoints must all be absent. This check runs
inside the original identity-bound Store under the existing mode lock. The
original budget ciphertext is reused without replacement; `budget_recovered`
reports this narrow case. An existing database with no valid budget is rejected.

Any selected message, attempt, consumed/uncertain state, subscription or protocol
checkpoint is refused without changing or replaying it. Existing positive
receipts are preserved. This is not general queue recovery. Keep the database
and inspect its authorized metadata; never delete it or choose an empty database
merely to permit another send.

`startService` and `callbackFactory` are code-injected test seams only; there is no
environment variable or CLI module-path selector. Production callers leave them
unset. The normal callback proxy, NO_PROXY refusal and TLS verification remain
unchanged; the proxy's final destination IP remains unverified.
