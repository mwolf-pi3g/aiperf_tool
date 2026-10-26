# aiperf_tool

Benchmarking harness for LLM inference performance on [vLLM](https://github.com/vllm-project/vllm),
used for the DGX Spark and DGX Station test campaigns.

Each model is brought up in its own vLLM container, verified, benchmarked with
[AIPerf](https://pypi.org/project/aiperf/) across a sweep of concurrency levels, and stopped
before the next one starts, so a previous model never holds GPU memory during a measurement.

---

## The pipeline

Three tools, run in this order, all driven by the same JSON model config:

| Step | Tool | What it does |
| --- | --- | --- |
| 1. Fetch | `bin/hfdl.sh` | Reports model sizes and (with `--dl`) downloads weights to `conf/hf_cache` |
| 2. Verify | `bin/container_setup.sh` | Creates each model's vLLM container, waits until it serves, stops it |
| 3. Benchmark | `bin/aiperf.sh` | Starts each container, runs the AIPerf sweep, stops it |

Step 2 is required before step 3: `container_setup` **creates** the containers, `aiperf`
only `docker start`s the existing ones. Step 2 is also the cheap place to catch a bad vLLM
flag — it fails in minutes instead of an hour into a sweep.

All wrapper scripts `cd` to the repo root themselves, so they can be called from anywhere.

---

## Requirements

- Linux with NVIDIA GPUs and a working `nvidia-container-toolkit`
- Docker with Compose v2
- Node.js (pinned version, installed by `bin/setup/node.sh`)
- Python 3 with `venv`
- Chromium (for AIPerf plot rendering; `bin/init.sh` installs it if missing)
- Disk space for weights — check before a large run; the HF cache grows to hundreds of GB

---

## Setup

### `bin/setup/node.sh` — install Node.js (once per machine)

Installs nvm and sets the pinned Node.js version (v24.14.1) as default.

```bash
bash bin/setup/node.sh
```

### `bin/init.sh` — prepare the shell (every new shell)

Creates/activates the Python venv in `venv/`, installs AIPerf into it, installs Chromium if
missing, and exports `BROWSER_PATH` / `CHOREO_CHROME_PATH` for AIPerf's plots. It must be
**sourced**, not executed, because it activates the venv in your current shell:

```bash
source bin/init.sh
```

Long runs take hours — start `tmux` first so a dropped SSH connection does not kill the sweep:

```bash
tmux new -s perf
```

---

## Quick start (example: small Gemma model)

`conf/gemma_test.json` benchmarks `google/gemma-4-E4B-it` at concurrency 1, 4 and 16.

```bash
source bin/init.sh
```

```bash
bin/hfdl.sh --models-conf conf/gemma_test.json --dl
```

```bash
bin/container_setup.sh --models-conf conf/gemma_test.json
```

```bash
bin/aiperf.sh --models-conf conf/gemma_test.json
```

Results land in `artifacts/<timestamp>_google_gemma-4-E4B-it_c1,4,16/`.

---

## The tools

### 1. `bin/hfdl.sh` — Hugging Face downloader

Queries the Hugging Face API for each model's size, prints a table with the total, and
optionally downloads the weights.

```bash
bin/hfdl.sh --models-conf conf/gemma_test.json          # sizes only, downloads nothing
bin/hfdl.sh --models-conf conf/gemma_test.json --dl     # sizes, then download
```

| Option | Meaning |
| --- | --- |
| `--models-conf <path>` | **Required.** Model config JSON (aliases: `--config`, `--conf-model`) |
| `--dl` | Actually download. Without it the tool only reports sizes |
| `--cache-dir <path>` | Cache directory (default `./conf/hf_cache`, which is what the containers mount) |
| `--keep-incomplete` / `--no-keep-incomplete` | Keep or delete partial downloads on failure (default: keep) |
| `--help`, `-h` | Show help |

Set `HF_TOKEN` in the environment for gated or private models. The containers run with
`HF_HUB_OFFLINE=1`, so **weights must be downloaded here before step 2**.

### 2. `bin/container_setup.sh` — container bring-up and verification

For each model in the config:

1. Stops any running `vllm-*` containers.
2. Runs `docker compose -f conf/base_compose.yaml -f conf/model_compose_overrides/<container>.yaml -p <container> up -d`.
3. Polls `http://localhost:8000/v1/models` until the model serves (or times out).
4. Stops the container (it is **not** removed, so step 3 can start it again).
5. On failure, writes the container's own logs into the output.

At the end it prints a PASSED/FAILED summary. Everything is also written to
`<timestamp>_container_setup.log` in the repo root.

```bash
bin/container_setup.sh --models-conf conf/gemma_test.json
bin/container_setup.sh --model google/gemma-4-E4B-it
bin/container_setup.sh --models-conf conf/gemma_test.json --model google/gemma-4-E4B-it
```

| Option | Meaning |
| --- | --- |
| `--models-conf <path>` | Model config JSON (alias: `--config`) |
| `--model`, `-m <name>` | Run only this model (alone, or picked out of `--models-conf`) |
| `--help`, `-h` | Show help |

The container name is derived from the model ID, e.g. `google/gemma-4-E4B-it` →
`vllm-google-gemma-4-e4b-it`. Re-run this step after **any** change to a compose file —
`docker compose up` recreates the container with the new settings.

### 3. `bin/aiperf.sh` — benchmark orchestrator

For each model in the config:

1. `docker start`s the container created in step 2.
2. Polls `/v1/models` until ready (timeout 30 min) and appends the bring-up time to
   `model_bringup.json`.
3. Runs `aiperf profile` over the model's concurrency list.
4. Stops the container and restarts `nvidia-persistenced` (see note below).

```bash
bin/aiperf.sh --models-conf conf/gemma_test.json
```

| Option | Meaning |
| --- | --- |
| `--models-conf <path>` | **Required.** Model config JSON (alias: `--config`) |
| `--help`, `-h` | Show help |

The workload is fixed in `bin/aiperf/aiperf_orchestrator.mjs` so that all models are
measured the same way:

| Setting | Value |
| --- | --- |
| Input / output length | 1024 / 512 tokens, stddev 0, `ignore_eos:true` (every request does identical work) |
| Duration per concurrency level | 300 s + 30 s grace period |
| Repeats | 2 profile runs per level, 60 s cooldown, aggregated with 95 % confidence intervals |
| Random seed | 42 |
| Endpoint | `http://localhost:8000/v1/chat/completions`, streaming |
| GPU telemetry | pynvml |
| Token counting | Server token counts, unless `tokenizer` is set in the config |

> **Note:** after each model the orchestrator runs `systemctl restart nvidia-persistenced`.
> That needs root — run `bin/aiperf.sh` as root (as on the DGX Station), or the run aborts
> after the first model.

---

## Configuration

### Model config — `conf/<name>.json`

A JSON array, one object per model. All three tools read the same file.

```json
[
  {
    "model": "google/gemma-4-E4B-it",
    "aiperf_args": "",
    "aiperf_concurrency": [1, 4, 16]
  }
]
```

| Field | Purpose |
| --- | --- |
| `model` | Hugging Face repo ID. Also determines the container name and override filename |
| `aiperf_concurrency` | Concurrency levels to sweep (one AIPerf sweep, one aggregate per level) |
| `aiperf_args` | Extra AIPerf flags appended to the fixed set, e.g. `--extra-inputs '{"chat_template_kwargs":{"enable_thinking":false}}'` |
| `tokenizer` | Optional. HF tokenizer for client-side token counting; omit to use server counts |
| `container_name` | Optional. Overrides the derived container name |

vLLM flags do **not** go here — they belong in the compose override.

### Container config — base + per-model override

The vLLM container for a model is defined by two Compose files layered on top of each other:

- **`conf/base_compose.yaml`** — shared by all models: the pinned vLLM image
  (`vllm/vllm-openai:v0.29.0`), GPU reservation, `shm_size`, the `conf/hf_cache` and
  `conf/vllm_cache` mounts, `HF_HUB_OFFLINE=1`, port 8000 and the healthcheck.
- **`conf/model_compose_overrides/<container-name>.yaml`** — per model: the full vLLM
  command line, and optionally a different `image:`, extra `environment:` entries or a
  longer healthcheck `start_period` for very large models.

Example (`conf/model_compose_overrides/vllm-google-gemma-4-e4b-it.yaml`):

```yaml
services:
  vllm:
    command: >
      --model google/gemma-4-E4B-it --served-model-name google/gemma-4-E4B-it --host 0.0.0.0 --port 8000 --max-model-len 32768 --gpu-memory-utilization 0.40 --max-num-seqs 256 --enable-prompt-tokens-details --trust-remote-code --async-scheduling --enable-auto-tool-choice --reasoning-parser gemma4 --tool-call-parser gemma4 --kv-cache-dtype fp8
```

Things to know:

- **`command:` is replaced, not merged.** The override's command line replaces the base
  one entirely, so every override carries the full flag list. Changing a flag in
  `base_compose.yaml` does not affect models that already have an override.
- **Missing overrides are generated.** If no override exists, `container_setup` writes one
  with baseline flags (`--gpu-memory-utilization 0.80 --max-num-seqs 256 …`). It never
  overwrites an existing file, so hand-tuned flags are safe — but check a generated file
  before trusting the first run (reasoning/tool parsers, memory utilization).
- **`--max-num-seqs` caps real concurrency.** If it is lower than the highest value in
  `aiperf_concurrency`, the extra requests just queue in vLLM and the top of the sweep
  measures queueing, not throughput.
- **Keep the image pinned.** A floating tag makes results from early and late in a
  campaign incomparable. If a model needs a different image, record that with its results.

---

## Output

| Path | Content |
| --- | --- |
| `artifacts/<timestamp>_<model>_c<levels>/` | One folder per model run |
| `…/aggregate/concurrency_<N>/profile_export_aiperf_aggregate.{json,csv}` | Aggregated metrics per concurrency level (throughput, TTFT, ITL, latency percentiles, GPU power …) |
| `…/aggregate/sweep_aggregate/` | Metrics across the whole sweep |
| `…/profile_runs/trial_000N/` | Raw per-run AIPerf exports |
| `…/plots/` | Auto-generated plots (e.g. `ttft_vs_throughput.png`) and `summary.txt` |
| `model_bringup.json` | Bring-up time and status for every model start |
| `<timestamp>_container_setup.log` | Log of each `container_setup` run |

All of these are gitignored. To publish a result set, copy `artifacts/`, the logs,
`model_bringup.json` and the package list into a separate results repo:

```bash
apt list --installed > app_versions.txt
```

---

## Before trusting a full run

- Free disk space covers the total that `hfdl.sh` reports.
- Every model PASSED in `container_setup`.
- `--max-num-seqs` in each override ≥ the highest concurrency in the config.
- No leftover container holds GPU memory between stages:

```bash
docker ps --filter "name=vllm-"
```

---

## Troubleshooting

**AIPerf fails on import or when rendering plots.** Install the headless-browser libraries:

```bash
sudo apt install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1
```

**A model fails readiness.** Read the container logs that `container_setup` writes into its
output on failure. Usual causes: an unsupported vLLM flag in the override, an image too old
for the model architecture, or the model not fitting at the configured
`--gpu-memory-utilization` / `--max-model-len`.

**The container starts but can't find the model.** Weights are not in `conf/hf_cache` —
run `hfdl.sh … --dl` first (containers are offline).

**`aiperf.sh` fails with "No such container".** Run `container_setup.sh` for that config first.

---

## Design notes

`bin/*/…_SDD.txt` contain the original design descriptions of each tool.
