// Code-only dependency injection. Never load an adapter or factory from an env path.
export function checkedOptions(options, allowed, message = 'Invalid requester options') {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(options))) throw new TypeError(message);
  const descriptors = Object.getOwnPropertyDescriptors(options);
  if (Reflect.ownKeys(descriptors).some(key => !allowed.includes(key) || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)) throw new TypeError(message);
  return options;
}
export function normalizeRequesterOptions(options) {
  checkedOptions(options, ['lookup', 'request', 'timeoutMs', 'maxBytes', 'proxyEnv', 'providerTimeoutMs', 'providerSend',
    'managedAdapter', 'managedCallbackAdapter', 'callbackTransport', 'callbackSend', 'callbackTimeoutMs', 'callbackMaxBytes']);
  const { managedAdapter, managedCallbackAdapter, callbackTransport, callbackSend } = options;
  if ((managedAdapter != null && managedCallbackAdapter != null && managedAdapter !== managedCallbackAdapter) ||
      (callbackTransport != null && callbackSend != null && callbackTransport !== callbackSend)) throw new TypeError('Conflicting callback injection');
  const adapter = managedAdapter ?? managedCallbackAdapter;
  const transport = callbackTransport ?? callbackSend;
  if (adapter != null) {
    checkedOptions(adapter, ['send'], 'Invalid managed callback adapter');
    if (!Object.hasOwn(adapter, 'send') || typeof adapter.send !== 'function') throw new TypeError('Invalid managed callback adapter');
  }
  if (transport != null && typeof transport !== 'function') throw new TypeError('Invalid callback transport');
  if (adapter != null && transport != null) throw new TypeError('Conflicting callback injection');
  return { ...options, managedAdapter: adapter, callbackTransport: transport };
}
