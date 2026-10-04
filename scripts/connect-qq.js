import fs from 'node:fs';
import { connectionPlan, inspectQrCredentials, redactedConnectionResult, runQrWizard } from '../src/connection-wizard.js';
import { BridgeError } from '../src/common.js';

try {
  const args = process.argv.slice(2);
  let result;
  if (!args.length || (args.length === 1 && args[0] === '--plan')) result = connectionPlan();
  else if (args.length === 1 && args[0] === '--demo') {
    let disposed = false, displayed = false;
    const candidate = await runQrWizard((callbacks, options) => {
      if (options.displayQrCodeToConsole !== false || options.source !== '') throw new Error('fixture contract');
      queueMicrotask(() => {
        callbacks.onQrDisplayed('https://q.qq.com/fixture-not-a-real-login');
        callbacks.onSuccess([{ appId: 'fixture-app', appSecret: 'fixture-not-a-real-secret', userOpenid: 'fixture-owner' }]);
      });
      return () => { disposed = true; };
    }, { scanAuthorized: true, licenseReviewReference: 'synthetic fixture only; no real connector is loaded',
      selection: { confirmedOwnerOpenid: 'fixture-owner', ownerEvidence: 'official-qr-response' }, displayQr: () => { displayed = true; } });
    result = { mode: 'OFFLINE_QR_INTERFACE_DEMO', ...redactedConnectionResult(candidate), synthetic_qr_callback: displayed, disposed };
  } else if (args.length === 2 && args[0] === '--inspect') {
    if (!fs.statSync(args[1]).isFile() || fs.statSync(args[1]).size > 16384) throw new BridgeError('Credential input must be a bounded local JSON file');
    let input;
    try { input = JSON.parse(fs.readFileSync(args[1], 'utf8')); } catch { throw new BridgeError('Invalid credential input JSON'); }
    result = { mode: 'OFFLINE_RESULT_INSPECTION', ...redactedConnectionResult(inspectQrCredentials(input.credentials, input.selection)) };
  } else throw new BridgeError('Usage: connect:qq [--plan | --demo | --inspect FILE]. Use scripts/qq-official-scan.js --plan for the official scanner and its explicit consent requirements.');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  process.stderr.write((error instanceof BridgeError ? error.message : 'Connection inspection failed; input values were not printed') + '\n');
  process.exitCode = 1;
}
