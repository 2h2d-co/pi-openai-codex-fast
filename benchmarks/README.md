# OpenAI Codex Fast benchmarks

Run the low- and medium-thinking benchmark suite for GPT-5.6 Terra and Sol against the local extension:

```bash
npm run benchmark
```

Select one model with the `--model` option:

```bash
npm run benchmark --model gpt-5.6-terra
npm run benchmark --model gpt-5.6-sol
```

The runner also accepts the same option directly:

```bash
node ./benchmarks/run.ts --model gpt-5.6-terra
```

The runner compares these providers separately for each model:

- `openai-codex/<model-id>`
- `openai-codex-fast/<model-id>`

It measures Pi CLI end-to-end latency, including process startup and JSON streaming. The normal and fast modes run as independent full benchmark sequences launched in parallel. Within each mode, thinking levels alternate by turn (`low, medium`, then repeat) instead of exhausting one level before moving to the next. Both modes use the same ordered sorter inputs. Every Pi invocation also gets a unique cache-bust system prompt nonce. Every run uses exact text validation and reports cache read/write tokens. The summary aggregates wall clock duration and TPS average, median, and standard deviation across all thinking levels.

It writes a separate pair of files for each model so that one model's run does not overwrite another's:

- `benchmarks/results.<model-id>.json`
- `benchmarks/summary.<model-id>.md`

## Configuration

Common:

- `--model <model-id>` selects one model; without it, Terra and Sol run sequentially
- `TIMEOUT_MS` defaults to `300000`

Sorter cases:

- `ITEM_COUNT` defaults to `200`
- `TURNS_PER_LEVEL` defaults to `2`
- `LEVELS` defaults to `low,medium`
