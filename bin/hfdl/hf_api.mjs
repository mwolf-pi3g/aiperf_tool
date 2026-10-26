import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const WEIGHT_EXTENSIONS = [
  '.safetensors',
  '.bin',
  '.pth',
  '.pt',
  '.onnx',
  '.gguf',
  '.ggml',
  '.h5',
  '.ot',
  '.msgpack'
];

/**
 * Queries the Hugging Face API to calculate the total size of model weights in bytes and GB.
 * @param {string} modelId - HuggingFace model repo identifier (e.g. 'Inferact/Qwen3.8-27B-NVFP4')
 * @param {string} [token] - Optional HuggingFace access token
 * @returns {Promise<{ sizeBytes: number, sizeGB: number, status: string, error?: string }>}
 */
export async function fetchModelSize(modelId, token = null) {
  const hfToken = token || process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN || null;
  const headers = {
    'User-Agent': 'model-size-checker/1.0'
  };

  if (hfToken) {
    headers['Authorization'] = `Bearer ${hfToken}`;
  }

  const url = `https://huggingface.co/api/models/${modelId}`;
  let attempts = 0;
  const maxAttempts = 3;

  const fetchImpl = globalThis.fetch || (await import('node-fetch')).default;

  while (attempts < maxAttempts) {
    attempts++;
    try {
      const response = await fetchImpl(url, { headers });

      if (response.status === 401 || response.status === 403) {
        return {
          sizeBytes: 0,
          sizeGB: 0,
          status: 'UNAUTHORIZED',
          error: `Access denied (HTTP ${response.status}). Set HF_TOKEN environment variable if this is a gated/private repository.`
        };
      }

      if (response.status === 404) {
        return {
          sizeBytes: 0,
          sizeGB: 0,
          status: 'NOT_FOUND',
          error: `Repository '${modelId}' not found on Hugging Face (HTTP 404).`
        };
      }

      if (!response.ok) {
        if (attempts < maxAttempts) {
          await delay(1000 * Math.pow(2, attempts - 1));
          continue;
        }
        return {
          sizeBytes: 0,
          sizeGB: 0,
          status: 'ERROR',
          error: `Hugging Face API returned HTTP status ${response.status}`
        };
      }

      const data = await response.json();
      const siblings = data.siblings || [];

      let totalBytes = 0;

      for (const file of siblings) {
        const filename = file.rfilename || '';
        const isWeightFile = WEIGHT_EXTENSIONS.some((ext) => filename.endsWith(ext));

        let fileSize = 0;
        if (file.lfs && typeof file.lfs.size === 'number') {
          fileSize = file.lfs.size;
        } else if (typeof file.size === 'number') {
          fileSize = file.size;
        }

        if (isWeightFile) {
          totalBytes += fileSize;
        }
      }

      // Fallback: If no explicit weight file extension matched, check all LFS files
      if (totalBytes === 0 && siblings.length > 0) {
        for (const file of siblings) {
          if (file.lfs && typeof file.lfs.size === 'number') {
            totalBytes += file.lfs.size;
          }
        }
      }

      // Secondary Fallback: Tree API
      if (totalBytes === 0) {
        totalBytes = await fetchTreeSize(modelId, headers, fetchImpl);
      }

      const sizeGB = parseFloat((totalBytes / (1024 * 1024 * 1024)).toFixed(2));

      return {
        sizeBytes: totalBytes,
        sizeGB,
        status: 'SUCCESS'
      };

    } catch (err) {
      if (attempts < maxAttempts) {
        await delay(1000 * Math.pow(2, attempts - 1));
      } else {
        return {
          sizeBytes: 0,
          sizeGB: 0,
          status: 'ERROR',
          error: `Network error querying Hugging Face API: ${err.message}`
        };
      }
    }
  }

  return {
    sizeBytes: 0,
    sizeGB: 0,
    status: 'ERROR',
    error: 'Exceeded maximum retries querying Hugging Face API.'
  };
}

/**
 * Fallback function to query Hugging Face Tree API for file sizes.
 * @param {string} modelId 
 * @param {object} headers 
 * @param {Function} fetchImpl
 * @returns {Promise<number>} Total size in bytes
 */
async function fetchTreeSize(modelId, headers, fetchImpl) {
  try {
    const treeUrl = `https://huggingface.co/api/models/${modelId}/tree/main`;
    const response = await fetchImpl(treeUrl, { headers });
    if (!response.ok) return 0;

    const files = await response.json();
    if (!Array.isArray(files)) return 0;

    let total = 0;
    for (const item of files) {
      const filename = item.path || item.rfilename || '';
      const isWeight = WEIGHT_EXTENSIONS.some((ext) => filename.endsWith(ext));

      let itemSize = 0;
      if (item.lfs && typeof item.lfs.size === 'number') {
        itemSize = item.lfs.size;
      } else if (typeof item.size === 'number') {
        itemSize = item.size;
      }

      if (isWeight) {
        total += itemSize;
      }
    }
    return total;
  } catch (err) {
    return 0;
  }
}

/**
 * Downloads a model repository from Hugging Face using the `hf` CLI tool.
 * Assumes `hf` is available in PATH.
 * @param {string} modelId - Hugging Face model repository identifier (e.g. 'Qwen/Qwen2.5-0.5B-Instruct')
 * @param {string} [cacheDir='./conf/hf_cache'] - Path to Hugging Face cache directory
 * @param {boolean} [keepIncomplete=true] - Whether to keep partial/incomplete downloads on failure
 * @returns {{ success: boolean, error?: string }} Result object with status and optional error message
 */
export function downloadHfModel(modelId, cacheDir = './conf/hf_cache', keepIncomplete = true) {
  try {
    const resolvedCacheDir = path.resolve(process.cwd(), cacheDir);
    if (!fs.existsSync(resolvedCacheDir)) {
      fs.mkdirSync(resolvedCacheDir, { recursive: true });
    }

    // const args = ['download', modelId, '--cache-dir', resolvedCacheDir];
    const args = ['download', modelId];
    const hfToken = process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN;
    if (hfToken) {
      args.push('--token', hfToken);
    }

    const env = {
      ...process.env,
      HF_HOME: resolvedCacheDir,
      //HF_HUB_CACHE: resolvedCacheDir,
    };

    const result = spawnSync('hf', args, {
      stdio: 'inherit',
      shell: false,
      env,
    });

    if (result.error) {
      return {
        success: false,
        error: `Failed to execute 'hf download ${modelId}': ${result.error.message}`
      };
    }

    if (result.status !== 0) {
      return {
        success: false,
        error: `'hf download ${modelId}' exited with status code ${result.status}`
      };
    }

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: `Unexpected error during download of '${modelId}': ${err.message}`
    };
  }
}

