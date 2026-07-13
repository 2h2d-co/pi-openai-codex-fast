# OpenAI Codex Fast benchmark summary

- Generated: 2026-05-16T15:20:42.291Z
- Target: Pi CLI end-to-end latency, including process startup and JSON streaming
- Normal model: `openai-codex/gpt-5.5`
- Fast model: `openai-codex-fast/gpt-5.5`
- Normal and fast modes run as independent full benchmark sequences launched in parallel.
- Within each mode, thinking-level order per pass is `off`, `minimal`, `low`, `medium`, `high`, `xhigh`; repeated 2 times.
- User prompts vary by turn; normal and fast modes use the same ordered sorter inputs.
- Every Pi invocation gets a unique cache-bust system prompt nonce.
- TPS is wall output tokens per second.

## Aggregate results

Exact matches: normal 12/12, fast 12/12.

| Metric | Normal average | Normal median | Normal std. dev. | Fast average | Fast median | Fast std. dev. |
|---|---:|---:|---:|---:|---:|---:|
| Wall clock duration | 38009.78 ms | 36876.42 ms | 2493.73 ms | 27604.28 ms | 26352.98 ms | 2689.27 ms |
| TPS | 49.94 | 50.08 | 0.66 | 69.46 | 71.42 | 5.37 |

## Aggregate matched-input comparison

| Metric | Fast wins | Median change |
|---|---:|---:|
| Wall clock duration | 12/12 | -29.26% |
| TPS | 12/12 | 42.99% |
