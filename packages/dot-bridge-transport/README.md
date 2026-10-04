# Shared callback transport

Dependency-free ESM package `@dot-bridge/callback-transport`, Node.js 22 or newer.
QQ and Lark use this one implementation. Temporary diagnostic publishers are not
included in this source distribution.
There are no provider clients, credential-file reads, proxy CONNECT implementation,
background sends, logs, persistence or automatic retries in this package.

## Distribution

The package is self-contained: copy `package.json`, `index.js`, `status.js`,
`transport.js` and this README together. It can be installed as a local/file
dependency by a separately approved deployment workflow and imported using its
standard package name. No package installation is needed for the current offline
tests, and no secret project path is embedded in the source.

The current source-tree layout also works without installation:

```
deployment-root/
  dot-qq-bridge/
    packages/
      dot-bridge-transport/
      dot-bridge-tunnel/
  dot-lark-bridge/
```

The QQ checkout owns the only shared source copy at
`packages/dot-bridge-transport/index.js`. The aggregate imports its adjacent
package, QQ imports its bundled package, and the sibling Lark clone imports
`../dot-qq-bridge/packages/dot-bridge-transport/index.js` relative to its repository
root. Copy both repositories for unified deployment. Do not duplicate transport
logic in Lark or copy a second top-level shared directory. The shared package can
also be copied independently using the five runtime/documentation files above;
include both `test/*.test.js` files to retain its complete offline regression suite.

From the QQ root, run `node --test packages/dot-bridge-transport/test/*.test.js`.
The aggregate's source-copy test verifies the packaged snapshot recorded in
`../source-copies.json`; runtime code is byte-identical to the reviewed source.
The complete QQ/Lark integration targets Node 24.15–24.x and requires their
separately installed pinned dependencies. The shared package alone needs no
third-party dependencies.

## API

`makeCallbackTransport(options)` returns a callable sender with `send.preflight()`.
Factory construction does not perform DNS/HTTP and can return a blocked sender
so that local setup/readiness remains available.

Options:

- `lookup`: injected all-address DNS resolver; default Node DNS lookup
- `request`: injected direct HTTPS requester; default Node HTTPS request
- `proxyEnv`: transport environment; missing/undefined uses process environment,
  explicit null is unsupported and never substitutes the real environment
- `timeoutMs`: total DNS, authorization, adapter/HTTP deadline, default 10000,
  maximum 30000 milliseconds
- `maxBytes`: response-body cap, default/maximum 262144 bytes
- `maxRequestBytes`: request-body cap, default/maximum 262144 bytes
- `managedAdapter`: future reviewed code object with exactly one own `send`
  function; no adapter implementation is included
- `callbackPolicy`: default `exact-hosts`. Only the temporary authenticated
  synthetic experiment explicitly uses `authenticated-dynamic-public-https`

`send(rawUrl, {method='POST', headers, body, hosts, beforeConnect, signal})` returns
`{status, headers, body: Buffer}`. Only POST is accepted. The production default
requires a bounded exact DNS hostname list in `hosts`; missing, empty or wildcard
lists do not authorize a callback. Dynamic mode is code-selected, not an
environment setting, and does not alter the production default.

`beforeConnect` is mandatory and may be synchronous or asynchronous. It is checked
before/after DNS and at network and completion boundaries. AbortSignal and the
total deadline cancel in-flight work and prevent late success. HTTP 2xx/4xx/5xx
statuses are returned after bounded validation so that the application retains
its own 410 retirement / retry-limit policy. Redirects are always rejected and
never followed. The transport itself makes one attempt and never retries.

Request and response header limits remain 8192 bytes and 32 response header pairs,
independent of body caps. Only callback-signature request headers are accepted;
Host, framing and TLS identity come from the validated destination. Response
headers are projected to bounded framing/encoding fields, not forwarded wholesale.
The synthetic wrapper retains stricter 8192-byte bodies and a 10000-ms deadline.

## Fixed readiness status

`preflightCallbackTransport(options)` and `send.preflight()` return exactly:

- `ready`: boolean
- `mode`: `direct`, `managed` or `blocked`
- `reason`: `none`, `proxy_policy_unverified`, `proxy_unsupported`,
  `adapter_invalid` or `transport_unverified`
- `proxy_configured`: boolean; null only for an unknown external sender
- `destination_binding`: `direct_pinned`, `delegated_to_adapter` or `unverified`
- `network_checked`: always false

Exports `callbackTransportStatusSchema` and
`projectCallbackTransportStatus(value)` provide the closed schema and a strict,
mode-consistent projection for all consumers. Unknown ad-hoc injected senders
must report blocked / transport_unverified / null / unverified, not pretend that
a network or platform contract was checked.

Ready describes configured code capability, never actual callback delivery,
provider access, platform identity, task activation or user wakeup.

## Direct and managed boundaries

Direct mode validates HTTPS DNS syntax, rejects credentials/fragments/custom ports
and IP literals, resolves all addresses for every send, rejects any non-public or
family-mismatched answer, copies one vetted candidate and supplies only that
address to the connection lookup. Original-host SNI/certificate checks remain
enabled. Neither address-family fallback nor alternate-address retry is used.
Outbound socket.remoteAddress is not used as final-target or TLS proof.

HTTPS proxy selection is nonempty `https_proxy` before `HTTPS_PROXY`; only the
selected value is parsed. HTTP/ALL variables are not supported HTTPS fallbacks.
An unsupported-proxy-only configuration blocks rather than becoming direct.
`no_proxy` similarly takes precedence over `NO_PROXY`. Matching hostname/IP or
strict IPv4/IPv6 CIDR rules reject a callback; they never select direct transport.
CIDR is this package's conservative deny extension, not a claim of native Node
CIDR semantics. Selected proxy/adapter changes cannot reroute an existing sender.

When a proxy is configured but no adapter exists, preflight is blocked with
`proxy_policy_unverified`, and send fails before DNS. Business approval, an
environment flag or a `verified` boolean cannot supply the missing platform
contract. This package contains no proxy socket, CONNECT or fallback route.

A future supported managed adapter must be implemented and reviewed against its
actual environment contract. Its presence is trusted dependency injection, not
an independent proof that the proxy's policy or final destination is verified.
Status remains `managed` / `delegated_to_adapter` / `network_checked:false`.

Adapter signature: `managedAdapter.send(target, request)`.
The deeply frozen validated target contains `url`, `hostname`, port 443, all
vetted `addresses`, one `selectedAddress`, original-host TLS requirements, and
`destinationBinding:'delegated_to_adapter'`. The request contains fixed POST,
projected signature headers, a copied body, selected proxy configuration for its
intended use, AbortSignal, remaining authorization guard and size/time limits.
It returns `{status, headers, body: Buffer}`, which the shared code validates
again. No raw adapter exception is exposed.

Use `request.beforeConnect(() => startNetworkOperation())` at each adapter network
boundary. A synchronous owner check and operation run in one stack; asynchronous
checks settle before the operation is invoked. Do not recommend “await a check,
then independently create a socket”: that separates authorization from the action.
A no-argument check is only a check and cannot authorize a later unguarded action.
The adapter must honor AbortSignal and enforce the supplied stream limits itself;
the shared layer additionally bounds total time and validates its returned body.

## Errors and offline tests

`CallbackTransportError` exposes only fixed `code` and identical `reason`, with a
static message and no raw cause/data. `TRANSPORT_ERROR_CODES` is the frozen array
consumers use for safe RPC projections. Standard Webhooks helpers
`decodeWebhookKey` / `signedHeaders` are also exported; they do not generate keys.

```
node --check index.js
node --check status.js
node --check transport.js
node --test
```

Tests inject DNS, HTTP and managed adapter behavior. They do not contact real
callbacks/providers, inspect real service keys, install packages or create tasks.
They establish code behavior, not real managed-platform acceptance.

### Preserved network regression coverage

Run `node --test test/*.test.js` from this package, or
`node --test packages/dot-bridge-transport/test/*.test.js` from the QQ root.
The shared suite contains 53 tests: 15 original contract tests, 32 shared-core
regressions extracted from the former synthetic transport suite, and 6 additional
NO_PROXY hostname/IP/CIDR selection and boundary matrices. All now import the
formal `index.js` directly and use exact-host production policy. DNS, HTTP and
managed operations are fully injected. The extracted fixtures explicitly retain
8192-byte request/response limits and short deadlines; production limits have
not been increased or otherwise changed.

Three of the old 35 tests were wrapper-specific and are not bundled: its
8192-byte/10000-ms factory ceilings, legacy four-field preflight projection, and
dynamic-host default. The original formal contract suite separately covers the
production ceilings, six-field status and code-only explicit dynamic mode. No
publisher, temporary server/CLI or deployment code is copied.

Coverage includes all-answer public-IP validation on every send, immutable
single-address pinning, original-host TLS, certificate failures, no redirect or
alternate-address retry, DNS changes, abort/expiry races, fixed error redaction,
selected proxy precedence, and conservative NO_PROXY denies. A socket's
remoteAddress never serves as final-destination proof. These are offline code
checks; configured managed proxies still require a separately reviewed adapter.
