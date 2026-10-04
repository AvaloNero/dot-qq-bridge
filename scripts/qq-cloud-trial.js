import { cloudTrialPlan, readCloudTrialConfig, probeExistingQqBot } from '../src/cloud-trial.js';
import { BridgeError } from '../src/common.js';
try {
  const args=process.argv.slice(2);
  if (!args.length || (args.length===1 && args[0]==='--plan')) console.log(JSON.stringify(cloudTrialPlan(),null,2));
  else if (args.length===2 && args[0]==='--probe' && args[1]==='--confirm-official-read') {
    // No automatic .env, credential-file loading, QR creation, or persistence.
    const result=await probeExistingQqBot(readCloudTrialConfig(),{approved:true});
    console.log(JSON.stringify(result,null,2));
    if(result.status!=='provider_discovery_passed')process.exitCode=1;
  } else throw new BridgeError('Usage: node scripts/qq-cloud-trial.js [--plan | --probe --confirm-official-read]. Probe requires separate approval and secure operator-provided environment.');
} catch(error){console.error(error instanceof BridgeError?error.message:'QQ diagnostic failed; no configuration values were printed');process.exitCode=1;}
