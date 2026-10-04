import path from 'node:path';
import { readQqCredentials } from './credential-store.js';
import { readServiceKey, validateTunnelServiceConfig } from './tunnel-service-auth.js';
import { openPrivateDirectory, privateDatabasePath } from './private-files.js';

export function assertApprovedTunnelLive(config, approvedLive) {
  if (config.authMode === 'tunnel-service' && (config.tunnelServiceOperation === 'live' || config.tunnelServiceReadinessOnly === false) && approvedLive !== true) {
    throw new Error('Tunnel live activation requires explicit approval');
  }
}

export function validateTunnelServiceOperation(config) {
  if (config.authMode !== 'tunnel-service') return;
  validateTunnelServiceConfig(config);
  if ([config.sitesOrigin, config.sitesBindingId, config.sitesPlatformToken, config.sitesConnectorToken,
    config.oauthIssuer, config.oauthJwksUrl, config.oauthAudience, config.devToken].some(Boolean)) throw new Error('Mixed Tunnel service authentication configuration');
  if (!['readiness', 'live'].includes(config.tunnelServiceOperation) ||
      config.tunnelServiceReadinessOnly !== (config.tunnelServiceOperation === 'readiness')) throw new Error('Invalid Tunnel service operation');
  if (config.tunnelServiceReadinessOnly) {
    if (config.dbPath !== ':memory:' || config.qqTransport !== 'disabled' || config.qqAppId || config.qqSecret || config.ownerOpenid ||
        config.callbackHosts.length || config.qqCredentialsFile || config.storageKeyFile || config.bridgeLockDirectory) throw new Error('Tunnel readiness requires empty ephemeral storage and disabled provider configuration');
    return;
  }
  if (config.qqTransport !== 'gateway' || config.qqApiProfile !== 'tencent-sdk' || config.dbPath === ':memory:' ||
      !path.isAbsolute(config.dbPath) || !path.isAbsolute(config.bridgeLockDirectory || '') || !config.qqCredentialsFile || !config.storageKeyFile) {
    throw new Error('Tunnel live requires explicit provider, credential files, private persistent storage and mode lock');
  }
  const files = [config.tunnelServiceKeyFile, config.qqCredentialsFile, config.storageKeyFile, config.dbPath];
  if (new Set(files).size !== files.length || files.slice(0, 3).some(file => ['-wal', '-shm', '-journal'].some(suffix => file === config.dbPath + suffix))) throw new Error('Tunnel credentials and storage must use independent files');
  const saved = readQqCredentials(config.qqCredentialsFile, { expectedAppId: config.qqAppId, profile: config.qqApiProfile });
  const storage = readServiceKey(config.storageKeyFile), service = readServiceKey(config.tunnelServiceKeyFile);
  if (saved.qqSecret !== config.qqSecret || saved.ownerOpenid !== config.ownerOpenid ||
      Buffer.from(storage, 'base64url').toString('base64') !== config.storageKey || storage === service || saved.qqSecret === service) {
    throw new Error('Tunnel live binding or independent credential verification failed');
  }
  privateDatabasePath(config.dbPath).close();
  openPrivateDirectory(config.bridgeLockDirectory).close();
}
