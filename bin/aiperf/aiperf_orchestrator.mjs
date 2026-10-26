import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  sanitizeContainerName,
  readJsonFile,
  appendBringupRecord,
  sanitizeModelName,
  getFormattedTimestamp,
  runCommand,
  pollEndpointReady,
  pollContainerStopped,
} from '../common/util.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BRINGUP_LOG_FILE = path.resolve('./model_bringup.json');
const READINESS_ENDPOINT = 'http://localhost:8000/v1/models';
const POLLING_TIMEOUT_MS = 1800000; // 30 minutes

let currentContainerName = null;

function printHelp() {
  console.log(`
===============================================================================
AIPERF ORCHESTRATOR SYSTEM
===============================================================================
Usage:
  node aiperf_orchestrator.mjs --models-conf <path> [options]

Options:
  --models-conf <path>     (Required) Path to input models JSON file (no default).
  --help, -h               Display this help message.

Example:
  node aiperf_orchestrator.mjs --models-conf ./models.json
===============================================================================
`);
}

function parseArgs(args) {
  const parsed = {
    modelsConf: null,
    help: false
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
    }
  }

  return parsed;
}

// Graceful signal and exception handling
function setupSignalHandlers() {
  const cleanupAndExit = async (signal) => {
    console.log(`\n[SIGNAL] Received ${signal}. Initiating graceful cleanup...`);
    if (currentContainerName) {
      console.log(`[CLEANUP] Stopping active container "${currentContainerName}"...`);
      try {
        await runCommand('docker', ['stop', currentContainerName]);
        await pollContainerStopped(currentContainerName, 1000, 30000);
      } catch (err) {
        console.error(`[ERROR] Failed to stop container "${currentContainerName}" on exit:`, err.message);
      }
    }
    process.exit(1);
  };

  process.on('SIGINT', () => cleanupAndExit('SIGINT'));
  process.on('SIGTERM', () => cleanupAndExit('SIGTERM'));
  process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION]:', err);
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

  if (!parsed.modelsConf) {
    console.error('[ERROR] Missing required argument --models-conf <path>.');
    printHelp();
    process.exit(1);
  }

  const modelsFilePath = path.resolve(process.cwd(), parsed.modelsConf);
  if (!fs.existsSync(modelsFilePath)) {
    console.error(`[ERROR] Model configuration file not found at path: ${parsed.modelsConf}`);
    process.exit(1);
  }

  console.log('====================================================');
  console.log('       AIPERF ORCHESTRATOR SYSTEM STARTING          ');
  console.log('====================================================');

  // Step 1: Input Validation
  const modelConfigs = readJsonFile(modelsFilePath, null);
  if (!Array.isArray(modelConfigs) || modelConfigs.length === 0) {
    console.error(`[ERROR] Model configuration file "${modelsFilePath}" is empty or invalid.`);
    process.exit(1);
  }

  console.log(`[INFO] Loaded ${modelConfigs.length} model benchmark configurations from "${modelsFilePath}".`);

  // Step 2: Process Each Model Configuration
  for (let i = 0; i < modelConfigs.length; i++) {
    const config = modelConfigs[i];
    const { model, tokenizer } = config;
    const aiperf_concurrency = config.aiperf_concurrency || config.concurrency;
    const aiperf_args = config.aiperf_args || config.extra;
    const container_name = config.container_name || (model ? sanitizeContainerName(model) : null);

    console.log(`\n----------------------------------------------------`);
    console.log(`[RUN ${i + 1}/${modelConfigs.length}] Processing Model: ${model}`);
    console.log(`[CONTAINER]: ${container_name}`);
    console.log(`----------------------------------------------------`);

    if (!model) {
      console.warn(`[SKIP] Missing model in entry at index ${i}. Skipping.`);
      continue;
    }

    currentContainerName = container_name;

    // A. Container Startup
    const startEpoch = Date.now();
    const startTimeISO = new Date(startEpoch).toISOString();
    console.log(`[START] Starting Docker container "${container_name}" at ${startTimeISO}...`);

    try {
      await runCommand('docker', ['start', container_name]);
    } catch (error) {
      console.error(`[ERROR] Failed to start container "${container_name}":`, error.message);
      appendBringupRecord(BRINGUP_LOG_FILE, {
        container_name,
        model,
        start_time: startTimeISO,
        end_time: new Date().toISOString(),
        total_time_ms: Date.now() - startEpoch,
        status: 'failed_to_start',
      });
      currentContainerName = null;
      continue;
    }

    // B. Readiness Polling
    let endEpoch;
    let endTimeISO;
    try {
      await pollEndpointReady(READINESS_ENDPOINT, 1000, POLLING_TIMEOUT_MS, console, container_name);
      endEpoch = Date.now();
      endTimeISO = new Date(endEpoch).toISOString();
    } catch (error) {
      console.error(`[ERROR] Container "${container_name}" failed readiness check:`, error.message);
      appendBringupRecord(BRINGUP_LOG_FILE, {
        container_name,
        model,
        start_time: startTimeISO,
        end_time: new Date().toISOString(),
        total_time_ms: Date.now() - startEpoch,
        status: 'timeout_waiting_ready',
      });

      // Stop container before proceeding
      await runCommand('docker', ['stop', container_name]).catch(() => { });
      await pollContainerStopped(container_name, 1000, 30000).catch(() => { });
      currentContainerName = null;
      continue;
    }

    const totalTimeMs = endEpoch - startEpoch;
    console.log(`[READY] Model container ready in ${(totalTimeMs / 1000).toFixed(2)}s (${totalTimeMs}ms).`);

    // C. Log Bringup Metrics
    appendBringupRecord(BRINGUP_LOG_FILE, {
      container_name,
      model,
      start_time: startTimeISO,
      end_time: endTimeISO,
      total_time_ms: totalTimeMs,
      status: 'ready',
    });

    // D. Invoke aiperf with CLI flags
    const timestampStr = getFormattedTimestamp(new Date());
    const sanitizedModel = sanitizeModelName(model);
    const concurrencyVal = aiperf_concurrency || '1';
    const concurrencySanitized = String(concurrencyVal).replace(/[^a-zA-Z0-9,._-]/g, '_');
    const artifactDir = `./artifacts/${timestampStr}_${sanitizedModel}_c${concurrencySanitized}`;

    const aiperfArgs = [
      'profile',
      '--ui', 'simple',
      '--endpoint-type', 'chat',
      '--endpoint', '/v1/chat/completions',
      '--streaming',
      '--url', 'http://localhost:8000',
      // Time-boxed instead of count-based. A fixed request count makes c=1 do the
      // same work as c=32 with no parallelism, so the low end dominates wall clock
      // while producing the least useful data. Fixed duration per level gives a
      // predictable total that does not depend on how slow a model turns out to be.
      '--benchmark-duration', '300',
      '--benchmark-grace-period', '30',
      // Two passes per configuration so aiperf can report std and confidence
      // intervals. With a single run it emits "num_successful=1 ... std=0, CI
      // collapsed to the mean" -- which reads as perfect precision but actually
      // means no information about repeatability. Cooldown separates the passes
      // so the second is not measured on a thermally hotter machine.
      '--num-profile-runs', '2',
      '--profile-run-cooldown-seconds', '60',
      '--gpu-telemetry', 'pynvml',
      '--slice-duration', '10',
      '--auto-plot',
      // Fixed seed: without it, synthetic prompts differ between runs, so
      // run-to-run variance mixes prompt variance with real signal. Pinning the
      // vLLM image is pointless if the workload drifts.
      '--random-seed', '42',
      // ISL/OSL sized for the DGX Spark: a balanced ~1K-in/1K-out interactive
      // shape that exercises prefill and decode roughly equally, and stays well
      // inside --max-model-len 32768 even at the top of the concurrency sweep.
      '--prompt-input-tokens-mean', '1024',
      // OSL 512, not 1024: with duration-based timing a longer OSL does not cost
      // wall clock, it just means fewer completed requests per window. 512 is still
      // a substantial decode workload while roughly doubling the sample count.
      '--prompt-output-tokens-mean', '512',
      // stddev 0 = every request is exactly ISL/OSL. Any value > 0 introduces
      // per-request length variability, which would blur the comparison between
      // models that this whole harness exists to make.
      '--prompt-input-tokens-stddev', '0',
      '--prompt-output-tokens-stddev', '0',
      // Without this, max_tokens is only a ceiling: models emit EOS early and
      // each request does a different amount of decode work, so e2e latency
      // differences between models are partly just answer-length differences.
      // Forcing generation to max_tokens makes every request identical work.
      // Global on purpose -- it is a methodology choice, not a model property.
      // (extra_inputs accumulates as a tuple list, so per-model --extra-inputs
      // in aiperf_args are appended, not overwritten.)
      '--extra-inputs', 'ignore_eos:true',
      '--model', `"${model}"`,
      '--concurrency', `"${concurrencyVal}"`,
      '--artifact-dir', `"${artifactDir}"`,
    ];

    if (tokenizer && String(tokenizer).trim() !== '') {
      aiperfArgs.push('--tokenizer', `"${tokenizer}"`);
    } else {
      aiperfArgs.push('--use-server-token-count');
    }

    if (aiperf_args) {
      if (Array.isArray(aiperf_args)) {
        aiperfArgs.push(...aiperf_args);
      } else if (typeof aiperf_args === 'string' && aiperf_args.trim() !== '') {
        aiperfArgs.push(aiperf_args.trim());
      }
    }

    console.log(`[AIPERF] Invoking aiperf benchmark session...`);
    try {
      await runCommand('aiperf', aiperfArgs);
      console.log(`[AIPERF] Benchmark session completed successfully for model "${model}".`);
    } catch (error) {
      console.error(`[ERROR] aiperf execution failed for model "${model}":`, error.message);
    }

    // E. Container Shutdown & Teardown Polling
    console.log(`[STOP] Stopping container "${container_name}"...`);
    try {
      await runCommand('docker', ['stop', container_name]);
      await pollContainerStopped(container_name, 1000, 30000);
    } catch (error) {
      console.error(`[WARNING] Error stopping container "${container_name}":`, error.message);
    }
    
    await runCommand('systemctl', ['restart', 'nvidia-persistenced']);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // await sleep(300000);

    currentContainerName = null;
  }

  console.log('\n====================================================');
  console.log('       AIPERF ORCHESTRATION COMPLETE                ');
  console.log('====================================================');
}

main().catch((err) => {
  console.error('[FATAL ERROR]:', err);
  process.exit(1);
});
