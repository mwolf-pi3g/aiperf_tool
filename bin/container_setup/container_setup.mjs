import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import {
  sanitizeContainerName,
  readJsonFile,
  getFormattedTimestamp,
  runCommand,
  pollEndpointReady,
  pollContainerStopped,
  getContainersByPrefix,
  stopContainersByPrefix,
  getContainerLogs,
} from '../common/util.mjs';

const READINESS_ENDPOINT = 'http://localhost:8000/v1/models';
const POLLING_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const POLLING_INTERVAL_MS = 2000; // 2 seconds

class Logger {
  constructor(logFilePath) {
    this.logFilePath = logFilePath;
    const dir = path.dirname(logFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.logFilePath, '', 'utf-8');
  }

  log(...args) {
    const msg = args.join(' ');
    console.log(msg);
    fs.appendFileSync(this.logFilePath, msg + '\n', 'utf-8');
  }

  warn(...args) {
    const msg = args.join(' ');
    console.warn(msg);
    fs.appendFileSync(this.logFilePath, msg + '\n', 'utf-8');
  }

  error(...args) {
    const msg = args.join(' ');
    console.error(msg);
    fs.appendFileSync(this.logFilePath, msg + '\n', 'utf-8');
  }
}

function printHelp() {
  console.log(`
===============================================================================
CONTAINER SETUP & VERIFICATION SYSTEM
===============================================================================
Usage:
  node bin/container_setup/container_setup.mjs [--models-conf <path> | --model <name>] [options]

Options:
  --models-conf <path>     Path to input models JSON file (e.g. conf/test.json).
  --model, -m <name>       One-shot run: create and test only the specified model.
  --help, -h               Display this help message.

Examples:
  node bin/container_setup/container_setup.mjs --models-conf conf/test.json
  node bin/container_setup/container_setup.mjs --model google/gemma-4-E4B-it
  node bin/container_setup/container_setup.mjs --models-conf conf/core_models.json --model google/gemma-4-E4B-it
===============================================================================
`);
}

function parseArgs(args) {
  const parsed = {
    modelsConf: null,
    model: null,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--models-conf' || arg === '--config') {
      if (args[i + 1]) {
        parsed.modelsConf = args[i + 1];
        i++;
      }
    } else if (arg.startsWith('--models-conf=')) {
      parsed.modelsConf = arg.slice('--models-conf='.length);
    } else if (arg.startsWith('--config=')) {
      parsed.modelsConf = arg.slice('--config='.length);
    } else if (arg === '--model' || arg === '-m') {
      if (args[i + 1]) {
        parsed.model = args[i + 1];
        i++;
      }
    } else if (arg.startsWith('--model=')) {
      parsed.model = arg.slice('--model='.length);
    }
  }

  return parsed;
}

let activeLogger = null;
let currentContainerName = null;

function setupSignalHandlers() {
  const cleanupAndExit = async (signal) => {
    if (activeLogger) {
      activeLogger.log(`\n[SIGNAL] Received ${signal}. Stopping containers starting with "vllm-"...`);
    } else {
      console.log(`\n[SIGNAL] Received ${signal}. Stopping containers starting with "vllm-"...`);
    }
    await stopContainersByPrefix('vllm-', activeLogger || console);
    process.exit(1);
  };

  process.on('SIGINT', () => cleanupAndExit('SIGINT'));
  process.on('SIGTERM', () => cleanupAndExit('SIGTERM'));
  process.on('uncaughtException', (err) => {
    if (activeLogger) {
      activeLogger.error('[UNCAUGHT EXCEPTION]:', err);
    } else {
      console.error('[UNCAUGHT EXCEPTION]:', err);
    }
    cleanupAndExit('uncaughtException');
  });
}

async function main() {
  setupSignalHandlers();

  const args = process.argv.slice(2);
  const parsed = parseArgs(args);

  if (parsed.help) {
    printHelp();
    process.exit(0);
  }

  if (!parsed.modelsConf && !parsed.model) {
    console.error('[ERROR] Missing required argument: specify --models-conf <path> or --model <modelName>.');
    printHelp();
    process.exit(1);
  }

  let modelsFilePath = null;
  let modelConfigs = [];

  if (parsed.modelsConf) {
    modelsFilePath = path.resolve(process.cwd(), parsed.modelsConf);
    if (!fs.existsSync(modelsFilePath)) {
      console.error(`[ERROR] Model configuration file not found at path: ${parsed.modelsConf}`);
      process.exit(1);
    }
    const loaded = readJsonFile(modelsFilePath, null);
    if (Array.isArray(loaded)) {
      modelConfigs = loaded;
    }
  }

  if (parsed.model) {
    const matching = modelConfigs.find(
      (c) => c.model === parsed.model || sanitizeContainerName(c.model) === sanitizeContainerName(parsed.model)
    );
    if (matching) {
      modelConfigs = [matching];
    } else {
      modelConfigs = [{ model: parsed.model }];
    }
  }

  const baseComposeFilePath = path.resolve(process.cwd(), 'conf/base_compose.yaml');
  if (!fs.existsSync(baseComposeFilePath)) {
    console.error(`[ERROR] Base Docker Compose file not found at path: ${baseComposeFilePath}`);
    process.exit(1);
  }

  const overridesDir = path.resolve(process.cwd(), 'conf/model_compose_overrides');
  if (!fs.existsSync(overridesDir)) {
    fs.mkdirSync(overridesDir, { recursive: true });
  }

  // Initialize Logger
  const timestampStr = getFormattedTimestamp(new Date());
  const logFileName = `${timestampStr}_container_setup.log`;
  const logFilePath = path.resolve(process.cwd(), logFileName);
  const logger = new Logger(logFilePath);
  activeLogger = logger;

  logger.log('====================================================');
  logger.log('       CONTAINER SETUP & VERIFICATION STARTING      ');
  logger.log('====================================================');
  if (modelsFilePath) {
    logger.log(`[INFO] Config file: ${modelsFilePath}`);
  }
  if (parsed.model) {
    logger.log(`[INFO] One-shot Model: ${parsed.model}`);
  }
  logger.log(`[INFO] Base Compose: ${baseComposeFilePath}`);
  logger.log(`[INFO] Log file:    ${logFilePath}`);

  if (modelConfigs.length === 0) {
    logger.error(`[ERROR] No valid model configurations found to execute.`);
    process.exit(1);
  }

  logger.log(`[INFO] Loaded ${modelConfigs.length} configuration row(s).`);

  // Step 2: Stop all existing running containers starting with "vllm-"
  logger.log('\n----------------------------------------------------');
  logger.log('[CLEANUP] Stopping existing running Docker containers...');
  logger.log('----------------------------------------------------');
  await stopContainersByPrefix('vllm-', logger);

  // Step 3: Process each configuration row
  const results = [];

  for (let i = 0; i < modelConfigs.length; i++) {
    const config = modelConfigs[i];
    const model = config.model;
    const containerName = config.container_name || (model ? sanitizeContainerName(model) : `vllm-bench-${i}`);

    logger.log('\n----------------------------------------------------');
    logger.log(`[ROW ${i + 1}/${modelConfigs.length}] Target Model: ${model}`);
    logger.log(`[CONTAINER NAME]: ${containerName}`);
    logger.log('----------------------------------------------------');

    if (!model) {
      logger.warn(`[SKIP] Missing model property at configuration index ${i}. Skipping.`);
      results.push({ index: i, model: 'unknown', status: 'SKIPPED', error: 'Missing model name' });
      continue;
    }

    currentContainerName = containerName;
    const startTime = Date.now();

    // Check for or generate model override compose file
    const overrideFilePath = path.join(overridesDir, `${containerName}.yaml`);
    if (!fs.existsSync(overrideFilePath)) {
      logger.log(`[INFO] Generating override compose file at ${overrideFilePath}...`);
      const baseFlags = '--host 0.0.0.0 --port 8000 --max-model-len 32768 --gpu-memory-utilization 0.80 --max-num-seqs 256 --enable-prompt-tokens-details --trust-remote-code';
      const cmd = (`--model ${model} --served-model-name ${model} ${baseFlags}`).trim().replace(/\s+/g, ' ');
      const yamlContent = `services:\n  vllm:\n    command: >\n      ${cmd}\n`;
      fs.writeFileSync(overrideFilePath, yamlContent, 'utf-8');
    }

    // A. Bring up container using docker compose stringing base and model override files
    logger.log(`[START] Spawning container "${containerName}" via Docker Compose (-f base_compose.yaml -f ${containerName}.yaml)...`);
    const env = {
      ...process.env,
      NAME: containerName,
    };

    let upSuccessful = false;
    try {
      await runCommand('docker', ['compose', '-f', baseComposeFilePath, '-f', overrideFilePath, '-p', containerName, 'up', '-d'], { env });
      upSuccessful = true;
    } catch (err) {
      logger.error(`[ERROR] Failed to bring up container "${containerName}":`, err.message);
    }

    if (!upSuccessful) {
      // Interleave container logs if available
      const logs = getContainerLogs(containerName);
      logger.error(`\n=== INTERLEAVED CONTAINER LOGS (${containerName}) ===`);
      logger.error(logs);
      logger.error(`=== END CONTAINER LOGS ===\n`);

      // Stop container if running
      await stopContainersByPrefix('vllm-', logger);
      currentContainerName = null;
      results.push({ index: i, model, containerName, status: 'FAILED_TO_START', error: 'Docker compose up failed' });
      continue;
    }

    // B. Poll inference endpoint
    let ready = false;
    let failureError = null;

    try {
      await pollEndpointReady(READINESS_ENDPOINT, POLLING_INTERVAL_MS, POLLING_TIMEOUT_MS, logger, containerName);
      ready = true;
    } catch (err) {
      failureError = err.message;
      logger.error(`[FAILURE] Container "${containerName}" failed readiness check:`, err.message);
    }

    const elapsedMs = Date.now() - startTime;
    const elapsedSec = (elapsedMs / 1000).toFixed(2);

    if (ready) {
      logger.log(`[SUCCESS] Model "${model}" is ready and available! (Time: ${elapsedSec}s)`);
      results.push({ index: i, model, containerName, status: 'SUCCESS', elapsedSec });

      // Stop the container that just came up (do NOT remove it)
      logger.log(`[TEARDOWN] Stopping container "${containerName}" after successful run...`);
      execSync(`docker stop ${containerName} 2>/dev/null || true`);
    } else {
      // Container failed to run or timed out
      logger.error(`[FAIL] Model "${model}" failed readiness after ${elapsedSec}s.`);

      // Interleave results in log
      const logs = getContainerLogs(containerName);
      logger.error(`\n=== INTERLEAVED CONTAINER LOGS (${containerName}) ===`);
      logger.error(logs);
      logger.error(`=== END CONTAINER LOGS ===\n`);

      results.push({ index: i, model, containerName, status: 'FAILED', elapsedSec, error: failureError });

      // Stop the container (do NOT remove it)
      logger.log(`[TEARDOWN] Stopping container "${containerName}"...`);
      execSync(`docker stop ${containerName} 2>/dev/null || true`);
    }

    currentContainerName = null;
  }

  // Summary Report
  logger.log('\n====================================================');
  logger.log('       CONTAINER SETUP EXECUTION SUMMARY            ');
  logger.log('====================================================');

  let passedCount = 0;
  let failedCount = 0;

  for (const res of results) {
    if (res.status === 'SUCCESS') {
      passedCount++;
      logger.log(`  [PASSED] ${res.model} (${res.containerName}) - ${res.elapsedSec}s`);
    } else {
      failedCount++;
      logger.error(`  [FAILED] ${res.model} (${res.containerName}) - Status: ${res.status} (${res.error || 'Unknown error'})`);
    }
  }

  logger.log('----------------------------------------------------');
  logger.log(`Total Models: ${results.length} | Passed: ${passedCount} | Failed: ${failedCount}`);
  logger.log(`Full log saved to: ${logFilePath}`);
  logger.log('====================================================');

  if (failedCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  if (activeLogger) {
    activeLogger.error('[FATAL ERROR]:', err);
  } else {
    console.error('[FATAL ERROR]:', err);
  }
  process.exit(1);
});
