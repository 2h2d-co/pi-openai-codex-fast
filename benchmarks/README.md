# OpenAI Codex Fast benchmarks

Run the full benchmark suite against the local extension:

```bash
mise run benchmark
```

Or directly:

```bash
node ./benchmarks/run.ts
```

The runner compares:

- `openai-codex/<MODEL_ID>`
- `openai-codex-fast/<MODEL_ID>`

It measures Pi CLI end-to-end latency, including process startup and JSON streaming. Each normal/fast pair runs sequentially with alternating order. Prompts vary by pair, and both sides of a pair receive the same prompt. Every run uses exact text validation and reports cache read/write tokens.

It writes:

- `benchmarks/results.json`
- `benchmarks/summary.md`

## Environment variables

Common:

- `MODEL_ID` defaults to `gpt-5.5`
- `TIMEOUT_MS` defaults to `300000`

Sorter cases:

- `ITEM_COUNT` defaults to `200`
- `PAIRS_PER_LEVEL` defaults to `5`
- `LEVELS` defaults to `off,minimal,low,medium,high,xhigh`
