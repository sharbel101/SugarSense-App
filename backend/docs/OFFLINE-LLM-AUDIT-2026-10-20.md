# Offline LLM for SugarSense: VM audit and recommendation (2026-10-20)

Nothing was installed, downloaded, configured or restarted. All VM commands were read-only, plus one 1 GB in-memory copy test (python, no files).
Verified = read from the VM or a model card on 2026-10-20. Estimate = my arithmetic, not measured. **No model was run here, so every speed figure is an estimate.**

## 1. The VM (verified)

| Item | Value |
|---|---|
| Host type | KVM guest (`systemd-detect-virt`), Oracle Cloud Ampere instance, Ubuntu 24.04.4, kernel 6.17.0-1020-oracle |
| CPU | 8 x Neoverse-N1 (aarch64), 1 thread/core. Has NEON, `asimddp` (int8 dot product), `fphp/asimdhp` (fp16). **No SVE, no i8mm, no bf16** |
| RAM | 46 GiB total, 44 GiB available, **no swap**. Page cache holds 25 GiB (reclaimable) |
| GPU | None (`nvidia-smi` absent, no GPU on `lspci`) |
| Disk | One 45 GB root disk, **18 GB free** (61% used). `/home/ubuntu/forecast` alone is 5.6 GB |
| Load | idle (load 0.08, CPU 100% idle) at audit time |
| Memory speed | single-thread copy 22.6 GB/s (read + write counted). Multi-thread figure not measured |
| Runtimes | Python 3.12.3, Docker 29.1.3 (user is in the `docker` group). **No** Ollama, llama.cpp, torch, transformers, CUDA. No `.gguf/.safetensors/.onnx` files; the only `.pt` is the 61 KB glucose GRU |
| Limits | No cgroup memory/CPU cap found on the host; Docker not inspected beyond `docker info` |
| Network | Outbound internet works (HuggingFace returned 200), so a one-time download is possible. Listening: 22, 80, 3000, 3100 (not ours), 8000, 8001, 8090, localhost-only Postgres 5432 |
| Shares the box with | the SugarSense backend, Postgres, forecast service (GRU + hypo/hyper), forecast-push, bg service, nginx, ngrok and three cloudflared tunnels |

Consequences: it is a CPU-only box, so speed is limited by memory bandwidth and by sharing 8 cores with production services. RAM and model size are not the constraint; **CPU time and latency are**. No i8mm means llama.cpp cannot use its fastest Arm kernels (it falls back to dot-product kernels).

## 2. Candidates (model cards, 2026-10-20)

| Rank | Model | License | Params | Context | Q4_K_M file | Notes |
|---|---|---|---|---|---|---|
| 1 | **Qwen/Qwen3.5-4B** | Apache-2.0 | 4B (card also shows "5B" in safetensors) | 262,144 native | **2.74 GB** (Q5_K_M 3.14, Q8_0 4.48) | Thinking on by default; turn off with `enable_thinking=false`. The old `/no_think` switch is not supported |
| 2 | **Qwen/Qwen3.5-9B** | Apache-2.0 | 9B | 262,144 native | **5.68 GB** (Q5_K_M 6.58, Q8_0 9.53) | Quality tier; about 2x slower than the 4B |
| 3 | **google/gemma-4-E4B-it** | Apache-2.0 | 4.5B effective, 8B with embeddings | 128K | **4.98 GB** (Q5_K_M 5.48) | Newer Gemma, permissive license. Larger file than its speed class |
| 4 | **microsoft/Phi-4-mini-instruct** | MIT | 3.8B | 128K | **2.49 GB** (Q8_0 4.08) | Lightest; model card warns it can invent function names/URLs |
| 5 | google/gemma-3-4b-it | **Gemma terms of use** (not an open-source license; acceptance required, prohibited-use policy) | 4B | 128K (8K output) | not fetched | Ranked last because of the license and age |
| ref | Qwen/Qwen3-8B | Apache-2.0 | 8.2B | 32K native (131K with YaRN) | not fetched | The model you named; superseded by Qwen3.5 on the Qwen page set, still a safe fallback |

I could not verify llama.cpp support for the Qwen3.5 and Gemma 4 architectures from their model cards. **Check that the llama.cpp release you build loads them before committing**, and fall back to Qwen3-8B or Phi-4-mini if not.

### Comparison

| Metric | Qwen3.5-4B | Qwen3.5-9B | Gemma 4 E4B | Phi-4-mini |
|---|---|---|---|---|
| Quantization | Q4_K_M (also try Q4_0, see below) | Q4_K_M | Q4_K_M | Q4_K_M |
| Disk (verified) | 2.74 GB | 5.68 GB | 4.98 GB | 2.49 GB |
| Peak RAM (est.) | ~4 GB at 8K context | ~7.5 GB | ~6.5 GB | ~3.5 GB |
| CPU fit | Good | Slow but usable for non-interactive | Fair | Good |
| GPU | Not needed | Not needed | Not needed | Not needed |
| Decode speed (est.) | 5-9 tok/s | 2.5-4.5 tok/s | 4-7 tok/s | 6-10 tok/s |
| Prompt speed (est.) | 25-60 tok/s | 10-25 tok/s | 20-45 tok/s | 30-70 tok/s |
| JSON reliability | High **if grammar-constrained** (see 4) | High with grammar, better judgement | High with grammar | Medium without grammar |
| Reasoning on multivariate data | Good for its size | Best of the list | Good | Fair |
| Context (use) | 8K | 8K | 8K | 8K |
| Fully local after install | Yes | Yes | Yes | Yes |

Speed method (estimate): decoding reads the whole weight file once per token, so tokens/s is roughly (usable memory bandwidth) / (file size). I measured 22.6 GB/s single-thread; I assumed 25-40 GB/s usable across 4-6 threads, then took 60-70% of the ceiling for real-world overhead. Prompt processing on this CPU (no i8mm) I assumed at several times slower than a modern x86 or Apple chip. The only published number I found is Oracle's Llama 3 8B on a 64-core A1 (30 tok/s at batch 1), which does not transfer to 8 cores. **Treat all of it as unmeasured until section 6.**

## 3. Recommendation

1. **Best overall: Qwen3.5-4B, Q4_K_M, thinking off, context 8192.** Apache-2.0, 2.74 GB, fits comfortably, the strongest instruction following in the small class on the cards I read, and a long native context so a week of summaries fits.
2. **Lightweight alternative: Phi-4-mini-instruct Q4_K_M** (MIT, 2.49 GB), if the 4B turns out too slow once measured.
3. **Higher quality: Qwen3.5-9B Q4_K_M** (5.68 GB). Run it as a nightly or on-demand "deep summary" job, not an interactive one.
4. **Runtime: llama.cpp (`llama-server`), not Ollama.** It runs on Arm with no GPU, exposes an OpenAI-compatible endpoint, and supports **JSON-schema / GBNF constrained decoding**, which is what guarantees parseable output. It also gives `llama-bench` for the plan below. Ollama wraps the same engine but hides thread, grammar and build controls.
5. **Quantization:** start with Q4_K_M; also benchmark **Q4_0**, because llama.cpp can repack Q4_0 into Arm dot-product kernels and is sometimes noticeably faster on Neoverse. Do not go below 4-bit for structured reasoning; Q5_K_M is a reasonable step up if latency allows.
6. **Storage:** model 2.74 GB + llama.cpp build ~0.5 GB + one spare model 5.7 GB + logs = about 10 GB, leaving ~8 GB of the 18 GB free. Do not keep many models; free space first (the 5.6 GB `forecast` folder is not mine to delete).
7. **Latency and concurrency (estimate):** a typical request is ~1,500 tokens in and ~350 out. For the 4B that is roughly 25-60 s of prompt plus 40-70 s of output, i.e. **about 1-2 minutes per request**; the 9B about 2-4 minutes. Capacity is **one request at a time** (`--parallel 1`); two concurrent requests each take about twice as long. This is fine for "explain my last 24 h" run in the background or on a schedule, **not** for a spinner on a button. Shrink the prompt (pre-summarise numbers in code) and cap output at ~300 tokens to get it down.

Trade-offs: a bigger model reasons better about combinations but costs speed linearly; an 8-core shared CPU makes the 9B a batch tool. Reliability comes from constrained decoding and validation, not from model size.

## 4. Safe integration (FastAPI sidecar)

Run the LLM as a separate service on `127.0.0.1` only (a systemd unit, `Nice=10`, `CPUQuota=400%`, `-t 4`) so it cannot starve the forecast and hypo/hyper alerts that share the box. The Nest backend (or FastAPI) calls it; the phone never does.

Pipeline: validate input (pydantic) -> normalise and **pre-compute every number in code** (time in range, min/max, slope, counts, hours since meal/dose; the LLM never calculates) -> fixed system prompt + JSON -> `llama-server` with `response_format` JSON schema -> validate the output again -> deterministic safety filter -> return.

Hard rules in the prompt and in the filter (the filter is what is trusted):
- Only use values present in the input; if a field is `null` say it is unknown. Never infer a missing measurement.
- Every statement carries `evidence` (the input field names it used) and a `kind` of `observation` or `hypothesis`.
- No insulin or carbohydrate amounts, no "take / inject / skip", no diagnoses, no "no need to worry". The filter rejects the whole answer if it matches a dose pattern (a number followed by units/U/g of carbs, or the words dose, inject, bolus + an imperative) and returns the deterministic summary instead.
- Alerts, thresholds and risk numbers come only from the existing ML and rules. The LLM output can add text but **cannot remove, lower or delay an alert**, and the response schema has no field for an alert level.
- Always append the fixed disclaimer ("Observations from your data, not medical advice") from code, not from the model.
- Timeout (90-120 s) or invalid output twice -> return the deterministic summary with `llm_status: "unavailable"`.
- Log counts and timing only, never the payload (health data).

Sample input (abridged):

```json
{
  "generated_at": "2026-10-20T18:00:00Z",
  "window_hours": 24,
  "glucose": {"current_mgdl": 168, "slope_mgdl_per_min": 0.9, "time_in_range_pct": 62, "min_mgdl": 71, "max_mgdl": 241,
              "predicted": {"30": 181, "60": 190}, "hypo_prob_30": 0.01, "hyper_prob_30": 0.18},
  "events": [{"type": "meal", "minutes_ago": 190, "carbs_g": 62, "fat_g": 75}, {"type": "insulin", "minutes_ago": 189, "units": 18}],
  "wearable": {"hr_now": 88, "hr_rest_delta": null, "hrv_rmssd": null, "coverage": 0.0},
  "missing": ["hrv_rmssd", "sleep"]
}
```

Output schema:

```json
{
  "summary": "string (max 400 chars)",
  "observations": [{"text": "string", "evidence": ["glucose.slope_mgdl_per_min"], "confidence": "low|medium|high"}],
  "hypotheses": [{"text": "string", "supports": ["events[0].fat_g"], "uncertainty": "string"}],
  "data_gaps": ["hrv_rmssd"],
  "suggestions": [{"text": "string (non-dosing, e.g. re-check glucose, log the meal)", "see_clinician": false}],
  "limits": "string"
}
```

(`additionalProperties: false`, string lengths and array sizes capped so the grammar bounds output length.) Conflict to note: `CLAUDE.md` says the anomaly agent runs on the phone and never in the cloud. This service is a separate server-side explainer fed by server data, not that agent, and should not be presented as it.

## 5. Install commands (not run; run on the VM when you approve)

```bash
sudo apt-get update && sudo apt-get install -y build-essential cmake git curl libcurl4-openssl-dev python3-venv
git clone https://github.com/ggml-org/llama.cpp ~/llama.cpp && cd ~/llama.cpp
cmake -B build -DGGML_NATIVE=ON -DCMAKE_BUILD_TYPE=Release && cmake --build build -j 6 --target llama-server llama-bench llama-cli
python3 -m venv ~/hf && ~/hf/bin/pip install -U "huggingface_hub[cli]"
mkdir -p ~/models && ~/hf/bin/hf download unsloth/Qwen3.5-4B-GGUF Qwen3.5-4B-Q4_K_M.gguf --local-dir ~/models
# smoke test, localhost only, thinking off, one slot
~/llama.cpp/build/bin/llama-server -m ~/models/Qwen3.5-4B-Q4_K_M.gguf -c 8192 -t 4 --parallel 1 \
  --host 127.0.0.1 --port 8181 --jinja --chat-template-kwargs '{"enable_thinking":false}'
```

Check the exact GGUF filename on the repo page first. Once the model file is on disk the service needs no internet.

## 6. Benchmark plan (turns every estimate above into a measurement)

1. `llama-bench -m <model> -p 512,1500 -n 128 -t 2,4,6,8` for each candidate and for Q4_K_M vs Q4_0. Record prompt and decode tok/s and peak RSS (`/usr/bin/time -v`).
2. Build 30 representative payloads from real stored data plus synthetic edge cases: flat, post-meal rise, overnight low, rapid fall, missing wearable, all-null, conflicting events, a payload that tries to inject instructions in a free-text field.
3. For each model run the full pipeline with the schema. Score: valid JSON rate (target 100% with grammar), schema pass, **evidence correctness** (every cited field exists and the number quoted matches), invented-measurement count (target 0), dose/diagnosis filter hits (target 0), end-to-end latency p50/p95, and a clinician-style read of 20 outputs for usefulness.
4. Run the same 30 with the forecast service under load to measure how much inference slows `GET /glucose`; set thread count and `CPUQuota` from that.
5. Pick the smallest model that passes the safety counts; do not choose by general benchmark scores, which say nothing about glucose interpretation.

## 7. Changes that would materially help

- A bigger shape of the same Oracle family (more OCPUs) or a second small instance dedicated to the LLM: speed scales almost linearly with cores and memory channels, and it removes the contention risk for the alerting services.
- A newer Arm core (Neoverse V2 class, with i8mm/SVE) would run prompts several times faster; this N1 box cannot.
- 18 GB of free disk is enough for one or two models, but resize before keeping several.
- No GPU is available on this instance type; do not plan around one.

## 8. Not verified

llama.cpp support for Qwen3.5 / Gemma 4 on Arm, every speed and RAM figure, Docker resource limits, multi-thread memory bandwidth, GGUF sizes for Qwen3-8B / Gemma 3. Model-card statements about JSON ability were absent for all candidates; none of these models has been shown medically accurate.
