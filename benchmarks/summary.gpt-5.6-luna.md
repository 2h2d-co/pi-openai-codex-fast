# OpenAI Codex Fast benchmark summary

- Generated: 2026-07-10T15:29:32.489Z
- Target: Pi CLI end-to-end latency, including process startup and JSON streaming
- Normal model: `openai-codex/gpt-5.6-luna`
- Fast model: `openai-codex-fast/gpt-5.6-luna`
- Normal and fast modes run as independent full benchmark sequences launched in parallel.
- Within each mode, thinking-level order per pass is `low`, `medium`; repeated 2 times.
- User prompts vary by turn; normal and fast modes use the same ordered sorter inputs.
- Every Pi invocation gets a unique cache-bust system prompt nonce.
- TPS is wall output tokens per second.

## Aggregate results

Exact matches: normal 4/4, fast 4/4.

| Metric | Normal average | Normal median | Normal std. dev. | Fast average | Fast median | Fast std. dev. |
|---|---:|---:|---:|---:|---:|---:|
| Wall clock duration | 40688.54 ms | 38681.91 ms | 4826.08 ms | 25824.8 ms | 25703.17 ms | 290.78 ms |
| TPS | 45.45 | 47.31 | 4.9 | 70.7 | 70.98 | 0.65 |

## Aggregate matched-input comparison

| Metric | Fast wins | Median change |
|---|---:|---:|
| Wall clock duration | 4/4 | -33.32% |
| TPS | 4/4 | 50.34% |

