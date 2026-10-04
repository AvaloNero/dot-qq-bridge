# Source-only handoff

This delivery contains source, tests and generic configuration templates. It contains no runtime keys, provider identities, callback addresses, private databases, logs, tunnel-client binaries or deployment state.

## Clone layout

Clone the two repositories below under the same parent directory, preserving their directory names:

```text
work/
  dot-qq-bridge/       branch feat/qq-mcp-events-v1
    packages/dot-bridge-transport/
    packages/dot-bridge-tunnel/
    tools/tunnel-stack/
  dot-lark-bridge/     branch feat/owner-only-lark-mcp-events
```

The repositories are `https://github.com/AvaloNero/dot-qq-bridge` and `https://github.com/AvaloNero/dot-lark-bridge`. Use the exact handoff commit IDs when reproducing a reviewed snapshot; branch tips can change.

The shared transport is maintained in the QQ repository. Both bridge applications and the aggregate router use that one source. Do not copy an older standalone shared directory alongside the clones.

## Offline checks

Use Linux or native Windows on local NTFS, with Node 24.15 or later within major version 24 and an existing Python 3.10+ interpreter. Windows safety and test boundaries are documented in [the platform layer](../packages/dot-bridge-platform/README.md); an actual Linux regression run remains separate. Install each repository's locked dependencies from the official npm registry with lifecycle scripts disabled. No account credentials are needed for checks.

```sh
cd dot-qq-bridge
npm ci --ignore-scripts --registry=https://registry.npmjs.org
node scripts/check.js
node --test --test-concurrency=1 test/*.test.js
node --test packages/dot-bridge-transport/test/*.test.js
node --test packages/dot-bridge-tunnel/test/*.test.js
cd ../dot-lark-bridge
npm ci --ignore-scripts --registry=https://registry.npmjs.org
node scripts/check.js
node --test --test-concurrency=1 test/*.test.js
```

The test suite uses synthetic fixtures and loopback listeners. It does not prove a remote callback or provider message has succeeded. Launcher checks and configuration are documented in [the launcher guide](../tools/tunnel-stack/README.md).

## Safe continuation

- Default bridge authentication remains deny; private service mode is explicit and binds the loopback socket to one configured owner. Caller identity headers never grant identity or routing authority.
- Readiness uses an empty in-memory store, disables provider transports and excludes message tools and subscriptions.
- Live mode needs explicit CLI activation, verified channel-owner pairing, separate file-referenced service and storage keys, and private storage. Existing credentials must be provisioned locally through an approved secure input route; do not migrate a different computer's keys.
- A valid subscription and callback policy must be present before provider traffic can begin. Replies target the original verified private conversation.
- Callback challenge and delivery share the tested transport implementation. HTTPS proxy configuration without a supported managed adapter is blocked before callback DNS/network activity. There is no hidden direct fallback or unverified IP CONNECT route.
- `callback_transport.ready` describes adapter configuration, not network acceptance. The status always reports `network_checked: false`.

## Remaining acceptance

An earlier private deployment verified current-dot read-only tool calls through Secure MCP Tunnel and discovery of a temporary diagnostic event schema. This is not portable authorization and does not establish a new deployment's connection.

The managed-proxy adapter and its final resolution/validation/connection guarantees remain unverified. Real Events subscription creation, authenticated callback delivery, dot wake-up and QQ/Feishu message/reply acceptance remain open. A new local environment needs its own network inspection before deciding whether the existing direct pinned transport is applicable. Do not change proxies, bypass policy, remove TLS verification, or create subscriptions merely to obtain callback details.

All local runtimes were stopped for this source handoff. Continue with offline checks and a non-network plan before requesting any new credential, ongoing access, pairing or real message-flow authorization.
