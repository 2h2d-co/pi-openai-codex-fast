# OpenAI Codex Fast benchmark summary

- Generated: 2026-07-10T15:17:41.019Z
- Target: Pi CLI end-to-end latency, including process startup and JSON streaming
- Normal model: `openai-codex/gpt-5.6-terra`
- Fast model: `openai-codex-fast/gpt-5.6-terra`
- Normal and fast modes run as independent full benchmark sequences launched in parallel.
- Within each mode, thinking-level order per pass is `low`, `medium`; repeated 2 times.
- User prompts vary by turn; normal and fast modes use the same ordered sorter inputs.
- Every Pi invocation gets a unique cache-bust system prompt nonce.
- TPS is wall output tokens per second.

## Aggregate results

Exact matches: normal 4/4, fast 4/4.

| Metric | Normal average | Normal median | Normal std. dev. | Fast average | Fast median | Fast std. dev. |
|---|---:|---:|---:|---:|---:|---:|
| Wall clock duration | 37574.23 ms | 37628.1 ms | 559.47 ms | 25852.29 ms | 25843.87 ms | 203.87 ms |
| TPS | 48.5 | 48.49 | 0.38 | 70.7 | 70.81 | 0.67 |

## Aggregate matched-input comparison

| Metric | Fast wins | Median change |
|---|---:|---:|
| Wall clock duration | 4/4 | -30.77% |
| TPS | 4/4 | 45.52% |
