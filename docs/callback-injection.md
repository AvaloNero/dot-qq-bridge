# Callback sender injection

Both bridges use the same code-only injection names:

- `makePublicRequester({ managedAdapter })` takes a reviewed adapter object with exactly one own data property, `send(target, request)`.
- `makePublicRequester({ callbackTransport })` takes a callback transport function. Its optional `preflight()` is projected into the closed callback status schema; absent or malformed status stays unverified.
- `managedCallbackAdapter` and `callbackSend` are compatibility aliases. Conflicting aliases, simultaneous adapter and transport overrides, unknown option names, and malformed objects throw fixed errors before request construction. Repeating the identical object under both alias names is accepted.

These are dependency injection interfaces in this project. They do not identify an official installed proxy component. No supported real managed callback adapter is supplied here. A synthetic adapter's response, an injected status, or `ready: true` is not evidence of working network transport. Managed status retains `destination_binding: delegated_unverified` and `network_checked: false`.

The launcher calls `createServiceSender({ proxyEnv, requesterFactory })` once. Its default is `makePublicRequester`; a future reviewed launcher can provide a statically imported code factory that calls `makePublicRequester({ ...options, managedAdapter })`. The factory receives `{ proxyEnv }` and returns the sender function. No environment flag, module path, arbitrary import, credential, or permission switch selects a factory. Existing proxy configuration with no adapter remains blocked before DNS or network access. The existing direct pinned path remains available in environments without a proxy.

Pass the returned `send` to the service and its preflight. The service forwards that exact function into the app and the selected Sites runtime. Callback challenge and queued event dispatch both use the app's sender. Provider request routing and provider/callback budgets retain their existing defaults.

All plan and unconfirmed branches return before sender or credential construction. Configuration checks are local configuration inspection, and can read approved credential file references when they validate configuration; they never establish network readiness.

QQ formal wiring lives in `scripts/qq-service.js`: `servicePreflight(env, { send })` reads callback state from that sender, then `startLockedPersistentService(config, { send, ...options })` forwards it through `startPersistentService` to `createApp`. Keep the same sender for repeated preflight calls; never recompute callback transport from the environment independently. `src/main.js` uses this same entrypoint. A standalone `servicePreflight(env)` constructs an inspection sender and does not start a service.

Offline verification: `node --test --test-concurrency=1 test/requester-injection.test.js test/service-runtime.test.js test/service-mode-lock.test.js test/network-auth.test.js`. These tests use synthetic values, in-memory state, injected network functions and inert lifecycle doubles; they do not verify a deployed callback or connect to a provider.
