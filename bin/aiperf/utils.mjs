import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Safely reads a JSON file or returns a default value if missing/invalid.
 */
export function readJsonFile(filePath, defaultValue = null) {
  try {
    if (!fs.existsSync(filePath)) {
      return defaultValue;
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.warn(`[WARNING] Failed to read JSON file at ${filePath}:`, error.message);
    return defaultValue;
  }
}

/**
 * Writes data as formatted JSON to a file.
 */
export function writeJsonFile(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Appends a new bringup metric record to model_bringup.json without losing historical data.
 */
export function appendBringupRecord(filePath, record) {
  const existing = readJsonFile(filePath, []);
  const list = Array.isArray(existing) ? existing : [];
  list.push(record);
  writeJsonFile(filePath, list);
}

/**
 * Sanitizes model name for use in filesystem directory paths.
 */
export function sanitizeModelName(modelName) {
  if (!modelName) return 'unknown_model';
  return modelName
    .replace(/[^a-zA-Z0-9.\-_]/g, '_')
    .replace(/_+/g, '_');
}

/**
 * Formats a Date object into YYYYMMDD_HHMMSS string.
 */
export function getFormattedTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${yyyy}${mm}${dd}_${hh}${min}${ss}`;
}

/**
 * Executes a shell command using spawn, streaming output to process stdout/stderr.
 */
export function runCommand(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    console.log(`[EXEC] ${command} ${args.join(' ')}`);
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: true,
      ...options,
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command "${command} ${args.join(' ')}" exited with code ${code}`));
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Polls a target HTTP endpoint until HTTP status code 200 OK or timeout.
 */
export async function pollEndpointReady(url, intervalMs = 1000, timeoutMs = 300000) {
  const startTime = Date.now();
  console.log(`[POLL] Polling readiness at ${url} (timeout: ${timeoutMs / 1000}s)...`);

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        console.log(`[POLL] Endpoint ${url} is ready (HTTP ${response.status}).`);
        return true;
      }
    } catch {
      // Endpoint not ready yet or network error, continue polling
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Polling timeout reached (${timeoutMs / 1000}s) waiting for ${url}`);
}

/**
 * Polls docker container state until it is stopped/exited.
 */
export async function pollContainerStopped(containerName, intervalMs = 1000, timeoutMs = 60000) {
  const startTime = Date.now();
  console.log(`[POLL] Waiting for container "${containerName}" to stop...`);

  while (Date.now() - startTime < timeoutMs) {
    try {
      const { execSync } = await import('node:child_process');
      const inspectOut = execSync(`docker inspect -f "{{.State.Running}}" ${containerName} 2>/dev/null`, {
        encoding: 'utf-8',
      }).trim();

      if (inspectOut === 'false') {
        console.log(`[POLL] Container "${containerName}" successfully stopped.`);
        return true;
      }
    } catch {
      // Container might no longer exist or inspect failed, consider stopped
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  console.warn(`[WARNING] Container "${containerName}" state check timed out after ${timeoutMs / 1000}s.`);
  return false;
}
