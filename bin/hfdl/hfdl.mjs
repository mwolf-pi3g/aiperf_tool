#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fetchModelSize, downloadHfModel } from './hf_api.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function printHelp() {
  console.log(`
===============================================================================
HFDL - HUGGING FACE MODEL DOWNLOADER CLI
===============================================================================
Usage:
  node hfdl.mjs --models-conf <path> [options]

Options:
  --models-conf <path>     (Required) Path to input models JSON file (no default).
  --cache-dir <path>       (Optional) Path to cache directory (default: ./conf/hf_cache).
  --dl                     (Optional) Download models (default: false / no downloading).
  --keep-incomplete        (Optional) Keep partial/incomplete downloads on failure (default: true).
  --no-keep-incomplete     (Optional) Do not keep partial/incomplete downloads on failure.
  --help, -h               Display this help message.

Example:
  node hfdl.mjs --models-conf ./test_models.json
  node hfdl.mjs --models-conf ./test_models.json --dl
===============================================================================
`);
}

function parseArgs(args) {
  const parsed = {
    modelsConf: null,
    cacheDir: './conf/hf_cache',
    dl: false,
    keepIncomplete: true,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--dl') {
      parsed.dl = true;
    } else if (arg === '--keep-incomplete') {
      parsed.keepIncomplete = true;
    } else if (arg === '--no-keep-incomplete') {
      parsed.keepIncomplete = false;
    } else if (arg === '--cache-dir') {
      if (args[i + 1]) {
        parsed.cacheDir = args[i + 1];
        i++;
      }
    } else if (arg.startsWith('--cache-dir=')) {
      parsed.cacheDir = arg.slice('--cache-dir='.length);
    } else if (arg === '--models-conf' || arg === '--config' || arg === '--conf-model') {
      if (args[i + 1]) {
        parsed.modelsConf = args[i + 1];
        i++;
      }
    } else if (arg.startsWith('--models-conf=')) {
      parsed.modelsConf = arg.slice('--models-conf='.length);
    } else if (arg.startsWith('--config=')) {
      parsed.modelsConf = arg.slice('--config='.length);
    } else if (arg.startsWith('--conf-model=')) {
      parsed.modelsConf = arg.slice('--conf-model='.length);
    }
  }

  return parsed;
}

function locateConfigFile(configPathArg) {
  if (!configPathArg) {
    console.error(`\x1b[31mError: Missing required argument --models-conf <path>.\x1b[0m`);
    process.exit(1);
  }
  const resolved = path.resolve(process.cwd(), configPathArg);
  if (fs.existsSync(resolved)) {
    return resolved;
  }
  console.error(`\x1b[31mError: Model configuration file not found at specified path: ${configPathArg}\x1b[0m`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const parsed = parseArgs(args);

  if (parsed.help) {
    printHelp();
    process.exit(0);
  }

  if (!parsed.modelsConf) {
    console.error(`\x1b[31mError: Missing required argument --models-conf <path>.\x1b[0m`);
    printHelp();
    process.exit(1);
  }

  if (!process.env.HF_TOKEN && !process.env.HUGGING_FACE_HUB_TOKEN) {
    console.warn(`\x1b[33m[WARN]\x1b[0m Environment variable 'HF_TOKEN' is not set. Downloads for gated/private models may fail.`);
  }

  const configPath = locateConfigFile(parsed.modelsConf);
  console.log(`\x1b[36m[INFO]\x1b[0m Reading model matrix from: ${configPath}`);
  console.log(`\x1b[36m[INFO]\x1b[0m Download option: \x1b[1m${parsed.dl ? 'ENABLED (--dl)' : 'DISABLED (default)'}\x1b[0m`);
  console.log(`\x1b[36m[INFO]\x1b[0m Keep partial downloads: \x1b[1m${parsed.keepIncomplete ? 'ENABLED (default)' : 'DISABLED'}\x1b[0m`);
  console.log(`\x1b[36m[INFO]\x1b[0m Cache directory: \x1b[1m${parsed.cacheDir}\x1b[0m\n`);

  let rawConfig;
  try {
    rawConfig = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    console.error(`\x1b[31mError reading config file:\x1b[0m ${err.message}`);
    process.exit(1);
  }

  let modelList;
  try {
    modelList = JSON.parse(rawConfig);
    if (!Array.isArray(modelList)) {
      throw new Error("JSON root must be an array of model objects.");
    }
  } catch (err) {
    console.error(`\x1b[31mError parsing JSON config:\x1b[0m ${err.message}`);
    process.exit(1);
  }

  if (modelList.length === 0) {
    console.error(`\x1b[31mError: models.json is empty.\x1b[0m`);
    process.exit(1);
  }

  let allPassed = true;
  let totalAllModelsSizeGB = 0;
  const items = [];

  console.log(`\x1b[36m[INFO]\x1b[0m Querying model sizes apriori...\n`);

  for (const entry of modelList) {
    const model = typeof entry === 'string' ? entry : entry?.model;
    if (!model) {
      console.warn(`\x1b[33m[WARN]\x1b[0m Skipping entry without 'model' property:`, entry);
      continue;
    }

    process.stdout.write(`Querying Hugging Face for model '${model}'... `);
    const hfRes = await fetchModelSize(model);

    let isQuerySuccess = true;
    if (hfRes.status === 'SUCCESS') {
      totalAllModelsSizeGB += hfRes.sizeGB;
      process.stdout.write(`\x1b[32mDone\x1b[0m (${hfRes.sizeGB} GB)\n`);
    } else {
      isQuerySuccess = false;
      allPassed = false;
      process.stdout.write(`\x1b[31mFailed\x1b[0m (${hfRes.error || hfRes.status})\n`);
    }

    items.push({
      model,
      sizeGB: hfRes.status === 'SUCCESS' ? hfRes.sizeGB : null,
      sizeGBStr: hfRes.status === 'SUCCESS' ? `${hfRes.sizeGB} GB` : 'N/A',
      isQuerySuccess,
      downloadStatus: 'SKIPPED',
      isDownloadSuccess: true
    });
  }

  const roundedTotalAllGB = parseFloat(totalAllModelsSizeGB.toFixed(2));

  console.log('\n===================================================================================================');
  console.log('                                     MODEL APRIORI SIZE REPORT                                     ');
  console.log('===================================================================================================');
  console.log(
    'Model'.padEnd(65) + ' | ' +
    'HF Size'
  );
  console.log('---------------------------------------------------------------------------------------------------');

  for (const r of items) {
    console.log(
      r.model.padEnd(65) + ' | ' +
      r.sizeGBStr
    );
  }
  console.log('---------------------------------------------------------------------------------------------------');
  console.log(`Total Apriori Size of Models: \x1b[1m\x1b[36m${roundedTotalAllGB} GB\x1b[0m`);
  console.log('===================================================================================================\n');

  if (!parsed.dl) {
    console.log(`\x1b[36m[INFO]\x1b[0m Download option \x1b[1m--dl\x1b[0m was not specified (default: no downloading). Downloads skipped.`);
    if (allPassed) {
      console.log(`\x1b[32mSUCCESS: All model sizes fetched successfully.\x1b[0m`);
      process.exit(0);
    } else {
      console.error(`\x1b[31mFAILURE: One or more models failed size query.\x1b[0m`);
      process.exit(1);
    }
  }

  console.log(`\x1b[36m[INFO]\x1b[0m Starting download of ${items.length} model(s) (Total Size: ${roundedTotalAllGB} GB)...\n`);

  for (const r of items) {
    if (!r.isQuerySuccess) {
      r.downloadStatus = 'N/A';
      r.isDownloadSuccess = false;
      console.log(`\x1b[33m[SKIP]\x1b[0m Model '${r.model}' skipped due to size query failure.`);
      continue;
    }

    console.log(`\x1b[36m[INFO]\x1b[0m Initiating download for '${r.model}' (${r.sizeGBStr}) via 'hf download ${r.model}' (cache: ${parsed.cacheDir})...`);
    const dlRes = downloadHfModel(r.model, parsed.cacheDir, parsed.keepIncomplete);
    if (dlRes.success) {
      r.downloadStatus = 'SUCCESS';
      r.isDownloadSuccess = true;
      console.log(`\x1b[32m[SUCCESS]\x1b[0m Model '${r.model}' downloaded successfully.\n`);
    } else {
      r.downloadStatus = 'FAILED';
      r.isDownloadSuccess = false;
      allPassed = false;
      console.error(`\x1b[31m[ERROR]\x1b[0m ${dlRes.error}\n`);
    }
  }

  console.log('\n===================================================================================================');
  console.log('                                     FINAL DOWNLOAD REPORT                                         ');
  console.log('===================================================================================================');
  console.log(
    'Model'.padEnd(55) + ' | ' +
    'HF Size'.padEnd(12) + ' | ' +
    'Download'
  );
  console.log('---------------------------------------------------------------------------------------------------');

  for (const r of items) {
    const downloadFormatted = r.downloadStatus === 'SUCCESS'
      ? `\x1b[32mSUCCESS\x1b[0m`
      : (r.downloadStatus === 'FAILED' ? `\x1b[31mFAILED\x1b[0m` : (r.downloadStatus === 'SKIPPED' ? `\x1b[90mSKIPPED\x1b[0m` : `\x1b[31mN/A\x1b[0m`));

    console.log(
      r.model.padEnd(55) + ' | ' +
      r.sizeGBStr.padEnd(12) + ' | ' +
      downloadFormatted
    );
  }
  console.log('---------------------------------------------------------------------------------------------------');
  console.log(`Total Size of Models: \x1b[1m\x1b[36m${roundedTotalAllGB} GB\x1b[0m`);
  console.log('===================================================================================================\n');

  if (allPassed) {
    console.log(`\x1b[32mSUCCESS: All models processed and downloaded successfully.\x1b[0m`);
    process.exit(0);
  } else {
    console.error(`\x1b[31mFAILURE: One or more models encountered errors.\x1b[0m`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Unexpected error:`, err);
  process.exit(1);
});
