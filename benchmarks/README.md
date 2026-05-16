# OpenAI Codex Fast benchmarks

Run the full benchmark suite against the local extension:

```bash
npm run benchmark
```

Or directly:

```bash
node ./benchmarks/run.ts
```

The runner compares:

- `openai-codex/<MODEL_ID>`
- `openai-codex-fast/<MODEL_ID>`

It measures Pi CLI end-to-end latency, including process startup and JSON streaming. The normal and fast modes run as independent full benchmark sequences launched in parallel. Within each mode, thinking levels alternate by turn (`off, minimal, low, ...`, then repeat) instead of exhausting one level before moving to the next. Both modes use the same ordered sorter inputs. Every Pi invocation also gets a unique cache-bust system prompt nonce. Every run uses exact text validation and reports cache read/write tokens. The summary aggregates wall clock duration and TPS average, median, and standard deviation across all thinking levels.

It writes:

- `benchmarks/results.json`
- `benchmarks/summary.md`

## Environment variables

Common:

- `MODEL_ID` defaults to `gpt-5.5`
- `TIMEOUT_MS` defaults to `300000`

Sorter cases:

- `ITEM_COUNT` defaults to `200`
- `TURNS_PER_LEVEL` defaults to `2`
- `LEVELS` defaults to `off,minimal,low,medium,high,xhigh`
