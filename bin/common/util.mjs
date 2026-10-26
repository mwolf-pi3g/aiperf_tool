import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';

/**
 * Sanitizes a model identifier into a valid Docker container name.
 * Rule: Lowercase, replace slashes, dots, spaces, and non-alphanumeric chars with hyphens.
 * Prepends 'vllm-' if not already present.
 * @param {string} modelName 
 * @returns {string} Sanitized Docker container name
 */
export function sanitizeContainerName(modelName) {
  if (!modelName || typeof modelName !== 'string') {
    return 'vllm-unknown-container';
  }

  let sanitized = modelName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/[/.]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');

  if (!sanitized.startsWith('vllm-')) {
    sanitized = `vllm-${sanitized}`;
  }

  return sanitized;
}

/**
 * Sanitizes model name for use in filesystem directory paths or log names.
 * @param {string} modelName
 * @returns {string} Sanitized string
 */
export function sanitizeModelName(modelName) {
  if (!modelName) return 'unknown_model';
  return modelName
    .replace(/[^a-zA-Z0-9.\-_]/g, '_')
    .replace(/_+/g, '_');
}

/**
 * Formats a Date object into YYYYMMDD_HHMMSS string.
 * @param {Date} date
 * @returns {string} Timestamp string
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
 * Executes a shell command using spawn, streaming output to process stdout/stderr.
 */
export function runCommand(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const cmdStr = `${command} ${args.join(' ')}`;
    console.log(`[EXEC] ${cmdStr}`);
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: true,
      ...options,
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Command "${cmdStr}" exited with code ${code}`));
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Executes a shell command using spawn and captures stdout/stderr.
 */
export function runCommandWithOutput(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const cmdStr = `${command} ${args.join(' ')}`;
    let stdout = '';
    let stderr = '';

    const child = spawn(command, args, {
      shell: true,
      ...options,
    });

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
    }

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        const error = new Error(`Command "${cmdStr}" exited with code ${code}`);
        error.stdout = stdout;
        error.stderr = stderr;
        error.code = code;
        reject(error);
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

export async function pollEndpointReady(url, intervalMs = 1000, timeoutMs = 300000, logger = console, containerName = null) {
  const startTime = Date.now();
  logger.log(`[POLL] Polling readiness at ${url} (timeout: ${timeoutMs / 1000}s)...`);

  while (Date.now() - startTime < timeoutMs) {
    if (containerName) {
      try {
        const inspectOut = execSync(`docker inspect -f "{{.State.Running}} {{.State.Status}}" ${containerName} 2>/dev/null`, { encoding: 'utf-8' }).trim();
        const [running, status] = inspectOut.split(' ');
        if (running === 'false' || status === 'exited' || status === 'dead') {
          throw new Error(`Container "${containerName}" exited prematurely with status "${status || 'exited'}".`);
        }
      } catch (err) {
        if (err.message.includes('exited prematurely')) {
          throw err;
        }
        throw new Error(`Container "${containerName}" is no longer running: ${err.message}`);
      }
    }

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        logger.log(`[POLL] Endpoint ${url} is ready (HTTP ${response.status}).`);
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
export async function pollContainerStopped(containerName, intervalMs = 1000, timeoutMs = 60000, logger = console) {
  const startTime = Date.now();
  logger.log(`[POLL] Waiting for container "${containerName}" to stop...`);

  while (Date.now() - startTime < timeoutMs) {
    try {
      const inspectOut = execSync(`docker inspect -f "{{.State.Running}}" ${containerName} 2>/dev/null`, {
        encoding: 'utf-8',
      }).trim();

      if (inspectOut === 'false') {
        logger.log(`[POLL] Container "${containerName}" successfully stopped.`);
        return true;
      }
    } catch {
      // Container might no longer exist or inspect failed, consider stopped
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  logger.warn(`[WARNING] Container "${containerName}" state check timed out after ${timeoutMs / 1000}s.`);
  return false;
}

/**
 * Retrieves all Docker container names matching a given prefix.
 * @param {string} prefix 
 * @returns {Array<string>} List of container names
 */
export function getContainersByPrefix(prefix = 'vllm-') {
  try {
    const output = execSync(`docker ps -a --format '{{.Names}}'`, { encoding: 'utf-8' });
    const containers = output
      .split('\n')
      .map((line) => line.trim())
      .filter((name) => name.startsWith(prefix));
    return containers;
  } catch (error) {
    console.warn(`[WARNING] Failed to query Docker container list:`, error.message);
    return [];
  }
}

/**
 * Stops (without removing) all containers starting with the specified prefix.
 * @param {string} prefix 
 * @param {Object} logger 
 */
export async function stopContainersByPrefix(prefix = 'vllm-', logger = console) {
  const containers = getContainersByPrefix(prefix);
  if (containers.length === 0) {
    logger.log(`[CLEANUP] No containers starting with "${prefix}" found.`);
    return;
  }

  logger.log(`[CLEANUP] Found ${containers.length} container(s) starting with "${prefix}": ${containers.join(', ')}`);

  for (const containerName of containers) {
    logger.log(`[CLEANUP] Stopping container "${containerName}"...`);
    try {
      execSync(`docker stop ${containerName} 2>/dev/null || true`, { stdio: 'ignore' });
      logger.log(`[CLEANUP] Container "${containerName}" stopped successfully.`);
    } catch (err) {
      logger.error(`[ERROR] Failed to stop container "${containerName}":`, err.message);
    }
  }
}

/**
 * Fetches recent logs from a Docker container.
 * @param {string} containerName 
 * @param {number} tailLines 
 * @returns {string} Combined stdout/stderr logs
 */
export function getContainerLogs(containerName, tailLines = 200) {
  try {
    const logs = execSync(`docker logs --tail ${tailLines} ${containerName} 2>&1`, { encoding: 'utf-8' });
    return logs;
  } catch (error) {
    return `[Unable to fetch docker logs for ${containerName}: ${error.message}]`;
  }
}
