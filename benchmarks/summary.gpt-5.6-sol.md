# OpenAI Codex Fast benchmark summary

- Generated: 2026-07-10T15:20:09.358Z
- Target: Pi CLI end-to-end latency, including process startup and JSON streaming
- Normal model: `openai-codex/gpt-5.6-sol`
- Fast model: `openai-codex-fast/gpt-5.6-sol`
- Normal and fast modes run as independent full benchmark sequences launched in parallel.
- Within each mode, thinking-level order per pass is `low`, `medium`; repeated 2 times.
- User prompts vary by turn; normal and fast modes use the same ordered sorter inputs.
- Every Pi invocation gets a unique cache-bust system prompt nonce.
- TPS is wall output tokens per second.

## Aggregate results

Exact matches: normal 4/4, fast 4/4.

| Metric | Normal average | Normal median | Normal std. dev. | Fast average | Fast median | Fast std. dev. |
|---|---:|---:|---:|---:|---:|---:|
| Wall clock duration | 37080.32 ms | 37040.22 ms | 471.99 ms | 25895.9 ms | 25900.92 ms | 286.88 ms |
| TPS | 48.9 | 48.92 | 0.87 | 70.17 | 70.4 | 0.65 |

## Aggregate matched-input comparison

| Metric | Fast wins | Median change |
|---|---:|---:|
| Wall clock duration | 4/4 | -30.07% |
| TPS | 4/4 | 43.93% |

