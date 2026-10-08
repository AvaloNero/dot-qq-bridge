import { QR_LOCAL_WAIT_MS, QR_WORKER_MAX_MS, QR_PROBE_MAX_MS } from '../src/qr-limits.js';
// Isolated one-shot SDK runtime. No .env loading or secret IPC. Persistence
// requires the explicit persistent-parent mode and its approved private path.
import { prepareCredentialDestination, saveQqCredentials } from '../src/credential-store.js';
import { installQrTransport, scanOfficialBot } from '../src/official-qr.js';
import { readCloudTrialConfig, probeExistingQqBot } from '../src/cloud-trial.js';
import { qrFailure, qrFailureReason } from '../src/qr-failures.js';
const emit = value => { if (process.connected) process.send(value); };
let started = false;
process.once('message', async config => {
  if (started) return; started = true;
  let restore, candidate, failureStage = 'setup_failed';
  const controller = new AbortController();
  const authorizationDeadlineEpochMs = Date.now() + QR_LOCAL_WAIT_MS;
  process.once('disconnect', () => controller.abort());
  const timer = setTimeout(() => process.exit(1), QR_WORKER_MAX_MS + (config.probeApproved === true ? QR_PROBE_MAX_MS : 0));
  try {
    if (config?.approved !== true || config.scannerIsOwner !== true) throw new Error();
    if (config.persistCredentials === true) prepareCredentialDestination(config.credentialDirectory);
    restore = installQrTransport({ diagnostic: emit, signal: controller.signal });
    failureStage = 'sdk_start_failed';
    const { startQrConnect } = await import('@tencent-connect/qqbot-connector');
    candidate = await scanOfficialBot(startQrConnect, { ...config, signal: controller.signal,
      displayQr: url => emit({ type: 'qr', url }) });
    restore(); restore = null;
    let saved = false;
    if (config.persistCredentials === true) {
      failureStage = 'credential_save_failed';
      // A resumed process must not persist a result after its wall-clock deadline.
      if (controller.signal.aborted) throw qrFailure('Official scan cancelled', 'cancelled');
      if (Date.now() >= authorizationDeadlineEpochMs) throw qrFailure('Official scan expired', 'local_deadline_reached');
      saveQqCredentials(candidate, { directory: config.credentialDirectory, expectedAppId: config.expectedAppId, profile: config.profile }); saved = true;
    }
    let diagnostic;
    if (config.probeApproved === true) {
      failureStage = 'provider_probe_failed';
      if (!['tencent-sdk', 'tencent-sandbox', 'documented'].includes(config.profile)) throw new Error();
      diagnostic = await probeExistingQqBot(readCloudTrialConfig({ QQ_APP_ID: candidate.appId,
        QQ_BOT_SECRET: candidate.appSecret, QQ_API_PROFILE: config.profile }), { approved: true, signal: controller.signal });
    }
    emit({ type: 'result', status: 'official_scan_validated', owner_identity_verified: true,
      credentials_written: saved, current_dot_connected: false, ...(diagnostic ? { diagnostic } : {}) });
  } catch (error) { emit({ type: 'result', status: 'scan_failed_or_scope_rejected', failure_reason: qrFailureReason(error, failureStage), credentials_written: false, current_dot_connected: false }); }
  finally { candidate = undefined; restore?.(); clearTimeout(timer); process.disconnect(); }
});
// Parent process termination is the hard deadline, including SDK in-flight I/O.
