import { fork } from 'node:child_process';
import { prepareCredentialDestination } from '../src/credential-store.js';
import { qrChildEnvironment, superviseQrChild } from '../src/qr-child-boundary.js';
const required = '--confirm-official-scan --confirm-scanner-is-owner --confirm-save-qq-credentials';
if (process.argv.slice(2).join(' ') !== required) {
  console.log(JSON.stringify({ mode: 'QQ_PERSISTENT_AUTHORIZATION_PLAN', scan_started: false, credentials_written: false,
    required_settings: ['QQ_APP_ID', 'QQ_CREDENTIAL_DIRECTORY'], destination_template: '${QQ_CREDENTIAL_DIRECTORY}/credentials.json', profile: 'tencent-sdk',
    required_arguments: required, service_started: false }));
} else {
  let child;
  try {
    const expectedAppId = process.env.QQ_APP_ID, credentialDirectory = process.env.QQ_CREDENTIAL_DIRECTORY;
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(expectedAppId ?? '') || typeof credentialDirectory !== 'string') throw new Error();
    prepareCredentialDestination(credentialDirectory);
    child = fork(new URL('./qq-scan-worker.js', import.meta.url), [], { env: qrChildEnvironment(process.env), execArgv: [], stdio: ['ignore','ignore','ignore','ipc'] });
    const controller = new AbortController(); process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
    superviseQrChild(child, { output: value => console.log(JSON.stringify(value)), failed: () => { process.exitCode = 1; },
      signal: controller.signal, allowCredentialsWritten: true });
    child.send({ approved: true, scannerIsOwner: true, expectedAppId, credentialDirectory, profile: 'tencent-sdk', persistCredentials: true, probeApproved: false });
  } catch { child?.kill(); console.log(JSON.stringify({ status: 'persistent_authorization_setup_failed', service_started: false })); process.exitCode = 1; }
}
