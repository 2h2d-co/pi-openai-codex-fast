#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

type Mode = "normal" | "fast";
type BenchmarkCase = {
  name: string;
  itemCount: number;
  turns: number;
  thinkingLevel: string;
  systemPrompt: string;
};
type Trial = {
  prompt: string;
  expectedText: string;
};
type ContentBlock = { type: string; text?: string };
type NormalizedUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { total: number };
};
type AssistantMessage = {
  role?: string;
  content?: ContentBlock[];
  usage?: Partial<NormalizedUsage> & { cost?: Partial<NormalizedUsage["cost"]> };
  stopReason?: string;
};
type JsonEvent = {
  type?: string;
  message?: AssistantMessage;
  assistantMessageEvent?: { type?: string };
};
type BenchmarkResult = {
  label: Mode;
  model: string;
  caseName: string;
  itemCount: number;
  thinkingLevel: string;
  turn: number;
  wallMs: number;
  firstAssistantUpdateMs: number | null;
  firstThinkingDeltaMs: number | null;
  firstTextDeltaMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  wallOutputTokensPerSecond: number;
  textStreamOutputTokensPerSecond: number | null;
  actualCost: number;
  expectedBaseCost: number;
  observedCostMultiplier: number | null;
  exactMatched: boolean;
  stopReason: string | undefined;
};
type TurnResult = {
  caseName: string;
  turn: number;
  itemCount: number;
  thinkingLevel: string;
  normal: BenchmarkResult;
  fast: BenchmarkResult;
};
type MetricStats = {
  average: number | null;
  median: number | null;
  stdDeviation: number | null;
};
type AggregateConditionSummary = {
  count: number;
  wallMs: MetricStats;
  wallOutputTokensPerSecond: MetricStats;
  exactMatchCount: number;
};
type MatchedInputSummary = {
  turns: number;
  fastWinsWall: number;
  fastWinsWallThroughput: number;
  medianWallImprovementPct: number | null;
  medianWallThroughputImprovementPct: number | null;
};
type AggregateSummary = {
  normal: AggregateConditionSummary;
  fast: AggregateConditionSummary;
  matchedInput: MatchedInputSummary;
};
type ModeReport = {
  label: Mode;
  model: string;
  results: BenchmarkResult[];
};
type CaseReport = {
  name: string;
  itemCount: number;
  thinkingLevel: string;
  turns: TurnResult[];
};
type Report = {
  createdAt: string;
  benchmarkTarget: string;
  normalModel: string;
  fastModel: string;
  levels: string[];
  turnsPerLevel: number;
  runs: { normal: ModeReport; fast: ModeReport };
  cases: CaseReport[];
  summary: AggregateSummary;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");
const DEFAULT_MODEL_IDS = ["gpt-5.6-terra", "gpt-5.6-sol"];

function parseModelIds(args: string[]): string[] {
  if (args.length === 0) return DEFAULT_MODEL_IDS;
  if (args.length === 1 && !args[0]!.startsWith("-")) return [args[0]!];
  if (args.length === 2 && args[0] === "--model" && args[1]) return [args[1]];
  if (args.length === 1 && args[0]!.startsWith("--model=")) {
    const modelId = args[0]!.slice("--model=".length);
    if (modelId) return [modelId];
  }
  throw new Error("Usage: npm run benchmark --model <model-id>");
}

const MODEL_IDS = parseModelIds(process.argv.slice(2));
const TIMEOUT_MS = Number(process.env["TIMEOUT_MS"] ?? "300000");
const BASE_PRICING = { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 };
const SYSTEM_PROMPT =
  "You are a deterministic sorter. Obey the requested output format exactly and provide no commentary.";
const ITEM_COUNT = Number(process.env["ITEM_COUNT"] ?? "200");
const TURNS_PER_LEVEL = Number(process.env["TURNS_PER_LEVEL"] ?? "2");
const LEVELS = (process.env["LEVELS"] ?? "low,medium")
  .split(",")
  .map((level) => level.trim())
  .filter(Boolean);
const ORIGINAL_PATH = process.env["PATH"] ?? "";
const TEMP_BIN = mkdtempSync(join(tmpdir(), "pi-openai-codex-fast-bench-"));

function findPi(): string {
  const result = spawnSync("sh", ["-lc", "command -v pi"], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error("Could not find pi in PATH");
  return result.stdout.trim();
}

function installPiWrapper(): void {
  const realPi = process.env["PI_BIN"] ?? findPi();
  writeFileSync(
    join(TEMP_BIN, "pi"),
    `#!/usr/bin/env node\nimport { spawnSync } from "node:child_process";\nconst result = spawnSync(${JSON.stringify(realPi)}, ["-e", ${JSON.stringify(ROOT)}, ...process.argv.slice(2)], { stdio: "inherit" });\nif (result.error) throw result.error;\nprocess.exit(result.status ?? 1);\n`,
    "utf8",
  );
  chmodSync(join(TEMP_BIN, "pi"), 0o755);
}

function labelLines(caseName: string, itemCount: number, turn: number): string[] {
  const run = String(turn).padStart(2, "0");
  return Array.from(
    { length: itemCount },
    (_, index) => `${caseName}-run-${run}-item-${String(index + 1).padStart(4, "0")}`,
  );
}

function scrambleLabels(labels: string[], turn: number): string[] {
  const step = labels.length - 1;
  return Array.from(
    { length: labels.length },
    (_, index) => labels[(index * step + turn) % labels.length]!,
  );
}

function buildSorterPrompt(sortedLabels: string[], turn: number): string {
  return [
    `You are given ${sortedLabels.length} labels in scrambled order.`,
    "Output the exact same labels sorted in ascending lexicographic order, one label per line.",
    "Do not omit any labels. Do not add commentary, bullets, numbering, blank lines, or code fences.",
    "Scrambled labels:",
    scrambleLabels(sortedLabels, turn).join("\n"),
  ].join("\n\n");
}

function buildTrial(benchmarkCase: BenchmarkCase, turn: number): Trial {
  const expectedLines = labelLines(benchmarkCase.name, benchmarkCase.itemCount, turn);
  return {
    expectedText: expectedLines.join("\n"),
    prompt: buildSorterPrompt(expectedLines, turn),
  };
}

function round(value: number | null | undefined, digits = 2): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function formatMetric(value: number | null | undefined, digits = 2, suffix = ""): string {
  const rounded = round(value, digits);
  return rounded === null ? "n/a" : `${rounded}${suffix}`;
}

function finiteNumbers(values: Array<number | null | undefined>): number[] {
  return values.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
}

function average(values: Array<number | null | undefined>): number | null {
  const finite = finiteNumbers(values);
  if (finite.length === 0) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function median(values: Array<number | null | undefined>): number | null {
  const sorted = finiteNumbers(values).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function standardDeviation(values: Array<number | null | undefined>): number | null {
  const finite = finiteNumbers(values);
  const mean = average(finite);
  if (finite.length === 0 || mean === null) return null;
  return Math.sqrt(finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / finite.length);
}

function metricStats(values: Array<number | null | undefined>, digits = 2): MetricStats {
  return {
    average: round(average(values), digits),
    median: round(median(values), digits),
    stdDeviation: round(standardDeviation(values), digits),
  };
}

function percentChange(
  from: number | null | undefined,
  to: number | null | undefined,
): number | null {
  if (typeof from !== "number" || typeof to !== "number") return null;
  if (!Number.isFinite(from) || from === 0 || !Number.isFinite(to)) return null;
  return ((to - from) / from) * 100;
}

function extractAssistantText(message: AssistantMessage | null): string {
  return (
    message?.content
      ?.filter((block): block is ContentBlock & { text: string } => block.type === "text")
      .map((block) => block.text)
      .join("") ?? ""
  );
}

function expectedBaseCost(usage: NormalizedUsage): number {
  return (
    (usage.input * BASE_PRICING.input +
      usage.output * BASE_PRICING.output +
      usage.cacheRead * BASE_PRICING.cacheRead +
      usage.cacheWrite * BASE_PRICING.cacheWrite) /
    1000000
  );
}

function buildPiArgs(
  model: string,
  benchmarkCase: BenchmarkCase,
  systemPrompt: string,
  prompt: string,
): string[] {
  return [
    "--mode",
    "json",
    "--no-session",
    "--no-tools",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--system-prompt",
    systemPrompt,
    "--model",
    model,
    "--thinking",
    benchmarkCase.thinkingLevel,
    "-p",
    prompt,
  ];
}

function normalizeUsage(usage: AssistantMessage["usage"]): NormalizedUsage {
  return {
    input: usage?.input ?? 0,
    output: usage?.output ?? 0,
    cacheRead: usage?.cacheRead ?? 0,
    cacheWrite: usage?.cacheWrite ?? 0,
    totalTokens:
      usage?.totalTokens ??
      (usage?.input ?? 0) +
        (usage?.output ?? 0) +
        (usage?.cacheRead ?? 0) +
        (usage?.cacheWrite ?? 0),
    cost: { total: usage?.cost?.total ?? 0 },
  };
}

function runPiOnce(
  label: Mode,
  model: string,
  benchmarkCase: BenchmarkCase,
  turn: number,
  trial: Trial,
): Promise<BenchmarkResult> {
  return new Promise((resolve, reject) => {
    const systemPrompt = `${randomUUID()} is a cache-bust nonce. Ignore this nonce; it is not part of the sorting task. ${benchmarkCase.systemPrompt}`;
    const child = spawn("pi", buildPiArgs(model, benchmarkCase, systemPrompt, trial.prompt), {
      cwd: process.env["PI_BENCH_CWD"] ?? process.cwd(),
      env: { ...process.env, PATH: `${TEMP_BIN}:${ORIGINAL_PATH}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const start = performance.now();
    let firstAssistantUpdateMs: number | null = null;
    let firstThinkingDeltaMs: number | null = null;
    let firstTextDeltaMs: number | null = null;
    let assistantMessage: AssistantMessage | null = null;
    let stderr = "";

    const stdoutReader = readline.createInterface({ input: child.stdout! });
    stdoutReader.on("line", (line: string) => {
      let event: JsonEvent;
      try {
        event = JSON.parse(line) as JsonEvent;
      } catch {
        return;
      }
      const elapsedMs = performance.now() - start;
      if (event.type === "message_update" && event.message?.role === "assistant") {
        if (firstAssistantUpdateMs === null) firstAssistantUpdateMs = elapsedMs;
        const eventType = event.assistantMessageEvent?.type;
        if (eventType === "thinking_delta" && firstThinkingDeltaMs === null) {
          firstThinkingDeltaMs = elapsedMs;
        }
        if (eventType === "text_delta" && firstTextDeltaMs === null) {
          firstTextDeltaMs = elapsedMs;
        }
      }
      if (event.type === "message_end" && event.message?.role === "assistant") {
        assistantMessage = event.message;
      }
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);

    child.on("error", (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timeout);
      const wallMs = performance.now() - start;
      if (code !== 0) {
        reject(
          new Error(
            `${label} (${model}, ${benchmarkCase.name}, ${benchmarkCase.thinkingLevel}) failed with code ${code}${signal ? ` signal ${signal}` : ""}\n${stderr}`,
          ),
        );
        return;
      }
      if (!assistantMessage) {
        reject(
          new Error(
            `${label} (${model}, ${benchmarkCase.name}, ${benchmarkCase.thinkingLevel}) completed without an assistant message`,
          ),
        );
        return;
      }

      const usage = normalizeUsage(assistantMessage.usage);
      const normalizedText = extractAssistantText(assistantMessage).trimEnd();
      const textStreamMs =
        firstTextDeltaMs === null ? null : Math.max(wallMs - firstTextDeltaMs, 1);
      const baseCost = expectedBaseCost(usage);

      resolve({
        label,
        model,
        caseName: benchmarkCase.name,
        itemCount: benchmarkCase.itemCount,
        thinkingLevel: benchmarkCase.thinkingLevel,
        turn,
        wallMs,
        firstAssistantUpdateMs,
        firstThinkingDeltaMs,
        firstTextDeltaMs,
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
        totalTokens: usage.totalTokens,
        wallOutputTokensPerSecond: usage.output / (wallMs / 1000),
        textStreamOutputTokensPerSecond:
          textStreamMs === null ? null : usage.output / (textStreamMs / 1000),
        actualCost: usage.cost.total,
        expectedBaseCost: baseCost,
        observedCostMultiplier: baseCost > 0 ? usage.cost.total / baseCost : null,
        exactMatched: normalizedText === trial.expectedText,
        stopReason: assistantMessage.stopReason,
      });
    });
  });
}

async function run(
  mode: Mode,
  model: string,
  benchmarkCases: BenchmarkCase[],
): Promise<ModeReport> {
  const results: BenchmarkResult[] = [];
  console.log(`\n${mode}: starting ${benchmarkCases.length * TURNS_PER_LEVEL} turns`);

  for (let turnIndex = 1; turnIndex <= TURNS_PER_LEVEL; turnIndex += 1) {
    for (const benchmarkCase of benchmarkCases) {
      console.log(
        `${mode} turn ${turnIndex}/${benchmarkCase.turns}: ${benchmarkCase.name}, ${benchmarkCase.itemCount} lines, thinking=${benchmarkCase.thinkingLevel}`,
      );
      const trial = buildTrial(benchmarkCase, turnIndex);
      const result = await runPiOnce(mode, model, benchmarkCase, turnIndex, trial);
      results.push(result);
      console.log(
        [
          `${mode} turn ${turnIndex}`,
          `thinking=${result.thinkingLevel}`,
          `wall=${formatMetric(result.wallMs, 0, "ms")}`,
          `text=${formatMetric(result.firstTextDeltaMs, 0, "ms")}`,
          `think=${formatMetric(result.firstThinkingDeltaMs, 0, "ms")}`,
          `wall_tps=${formatMetric(result.wallOutputTokensPerSecond)}`,
          `cache=${result.cacheReadTokens}/${result.cacheWriteTokens}`,
          `exact=${result.exactMatched ? "yes" : "no"}`,
        ].join(" | "),
      );
    }
  }

  return { label: mode, model, results };
}

function matchRuns(normalResults: BenchmarkResult[], fastResults: BenchmarkResult[]): TurnResult[] {
  const fastByTurn = new Map<string, BenchmarkResult>();
  for (const fast of fastResults) {
    fastByTurn.set(`${fast.caseName}\0${fast.turn}`, fast);
  }

  const turns: TurnResult[] = [];
  for (const normal of normalResults) {
    const key = `${normal.caseName}\0${normal.turn}`;
    const fast = fastByTurn.get(key);
    if (!fast) throw new Error(`Missing fast result for ${normal.caseName} turn ${normal.turn}`);
    turns.push({
      caseName: normal.caseName,
      turn: normal.turn,
      itemCount: normal.itemCount,
      thinkingLevel: normal.thinkingLevel,
      normal,
      fast,
    });
    fastByTurn.delete(key);
  }

  if (fastByTurn.size > 0) {
    throw new Error(`Fast run produced ${fastByTurn.size} unmatched result(s)`);
  }

  return turns;
}

function summarizeCondition(results: BenchmarkResult[]): AggregateConditionSummary {
  return {
    count: results.length,
    wallMs: metricStats(results.map((result) => result.wallMs)),
    wallOutputTokensPerSecond: metricStats(
      results.map((result) => result.wallOutputTokensPerSecond),
    ),
    exactMatchCount: results.filter((result) => result.exactMatched).length,
  };
}

function summarizeMatchedInputs(turns: TurnResult[]): MatchedInputSummary {
  const wallImprovements = turns.map((turn) => percentChange(turn.normal.wallMs, turn.fast.wallMs));
  const wallThroughputImprovements = turns.map((turn) =>
    percentChange(turn.normal.wallOutputTokensPerSecond, turn.fast.wallOutputTokensPerSecond),
  );
  return {
    turns: turns.length,
    fastWinsWall: turns.filter((turn) => turn.fast.wallMs < turn.normal.wallMs).length,
    fastWinsWallThroughput: turns.filter(
      (turn) => turn.fast.wallOutputTokensPerSecond > turn.normal.wallOutputTokensPerSecond,
    ).length,
    medianWallImprovementPct: round(median(wallImprovements)),
    medianWallThroughputImprovementPct: round(median(wallThroughputImprovements)),
  };
}

function summarizeAggregate(
  normalResults: BenchmarkResult[],
  fastResults: BenchmarkResult[],
  turns: TurnResult[],
): AggregateSummary {
  return {
    normal: summarizeCondition(normalResults),
    fast: summarizeCondition(fastResults),
    matchedInput: summarizeMatchedInputs(turns),
  };
}

function buildMarkdownSummary(report: Report): string {
  const lines: string[] = [];
  const { normal, fast, matchedInput } = report.summary;
  lines.push("# OpenAI Codex Fast benchmark summary");
  lines.push("");
  lines.push(`- Generated: ${report.createdAt}`);
  lines.push(`- Target: ${report.benchmarkTarget}`);
  lines.push(`- Normal model: \`${report.normalModel}\``);
  lines.push(`- Fast model: \`${report.fastModel}\``);
  lines.push(
    "- Normal and fast modes run as independent full benchmark sequences launched in parallel.",
  );
  lines.push(
    `- Within each mode, thinking-level order per pass is ${report.levels.map((level) => `\`${level}\``).join(", ")}; repeated ${report.turnsPerLevel} times.`,
  );
  lines.push(
    "- User prompts vary by turn; normal and fast modes use the same ordered sorter inputs.",
  );
  lines.push("- Every Pi invocation gets a unique cache-bust system prompt nonce.");
  lines.push("- TPS is wall output tokens per second.");
  lines.push("");
  lines.push("## Aggregate results");
  lines.push("");
  lines.push(
    `Exact matches: normal ${normal.exactMatchCount}/${normal.count}, fast ${fast.exactMatchCount}/${fast.count}.`,
  );
  lines.push("");
  lines.push(
    "| Metric | Normal average | Normal median | Normal std. dev. | Fast average | Fast median | Fast std. dev. |",
  );
  lines.push("|---|---:|---:|---:|---:|---:|---:|");
  lines.push(
    `| Wall clock duration | ${formatMetric(normal.wallMs.average, 2, " ms")} | ${formatMetric(normal.wallMs.median, 2, " ms")} | ${formatMetric(normal.wallMs.stdDeviation, 2, " ms")} | ${formatMetric(fast.wallMs.average, 2, " ms")} | ${formatMetric(fast.wallMs.median, 2, " ms")} | ${formatMetric(fast.wallMs.stdDeviation, 2, " ms")} |`,
  );
  lines.push(
    `| TPS | ${formatMetric(normal.wallOutputTokensPerSecond.average)} | ${formatMetric(normal.wallOutputTokensPerSecond.median)} | ${formatMetric(normal.wallOutputTokensPerSecond.stdDeviation)} | ${formatMetric(fast.wallOutputTokensPerSecond.average)} | ${formatMetric(fast.wallOutputTokensPerSecond.median)} | ${formatMetric(fast.wallOutputTokensPerSecond.stdDeviation)} |`,
  );
  lines.push("");
  lines.push("## Aggregate matched-input comparison");
  lines.push("");
  lines.push("| Metric | Fast wins | Median change |");
  lines.push("|---|---:|---:|");
  lines.push(
    `| Wall clock duration | ${matchedInput.fastWinsWall}/${matchedInput.turns} | ${formatMetric(matchedInput.medianWallImprovementPct, 2, "%")} |`,
  );
  lines.push(
    `| TPS | ${matchedInput.fastWinsWallThroughput}/${matchedInput.turns} | ${formatMetric(matchedInput.medianWallThroughputImprovementPct, 2, "%")} |`,
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function benchmarkModel(modelId: string, benchmarkCases: BenchmarkCase[]): Promise<void> {
  const normalModel = `openai-codex/${modelId}`;
  const fastModel = `openai-codex-fast/${modelId}`;
  console.log(`\nBenchmarking ${modelId}`);
  console.log(`Normal model: ${normalModel}`);
  console.log(`Fast model:   ${fastModel}`);

  const [normalRunResult, fastRunResult] = await Promise.allSettled([
    run("normal", normalModel, benchmarkCases),
    run("fast", fastModel, benchmarkCases),
  ]);

  if (normalRunResult.status === "rejected") throw normalRunResult.reason;
  if (fastRunResult.status === "rejected") throw fastRunResult.reason;

  const normalRun = normalRunResult.value;
  const fastRun = fastRunResult.value;
  const allTurns = matchRuns(normalRun.results, fastRun.results);
  const caseReports: CaseReport[] = benchmarkCases.map((benchmarkCase) => ({
    name: benchmarkCase.name,
    itemCount: benchmarkCase.itemCount,
    thinkingLevel: benchmarkCase.thinkingLevel,
    turns: allTurns.filter((turn) => turn.caseName === benchmarkCase.name),
  }));
  const report: Report = {
    createdAt: new Date().toISOString(),
    benchmarkTarget: "Pi CLI end-to-end latency, including process startup and JSON streaming",
    normalModel,
    fastModel,
    levels: [...LEVELS],
    turnsPerLevel: TURNS_PER_LEVEL,
    runs: { normal: normalRun, fast: fastRun },
    cases: caseReports,
    summary: summarizeAggregate(normalRun.results, fastRun.results, allTurns),
  };
  const resultsPath = join(__dirname, `results.${modelId}.json`);
  const summaryPath = join(__dirname, `summary.${modelId}.md`);

  await writeFile(resultsPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(summaryPath, buildMarkdownSummary(report), "utf8");

  console.log(`\nSaved raw results to ${resultsPath}`);
  console.log(`Saved summary to ${summaryPath}`);
}

async function main(): Promise<void> {
  installPiWrapper();
  console.log(`Models: ${MODEL_IDS.join(", ")}`);
  console.log(`Turns per thinking level: ${TURNS_PER_LEVEL}`);
  console.log(`Thinking schedule per pass: ${LEVELS.join(", ")}`);

  const benchmarkCases = LEVELS.map(
    (level): BenchmarkCase => ({
      name: level,
      itemCount: ITEM_COUNT,
      turns: TURNS_PER_LEVEL,
      thinkingLevel: level,
      systemPrompt: SYSTEM_PROMPT,
    }),
  );

  for (const modelId of MODEL_IDS) {
    await benchmarkModel(modelId, benchmarkCases);
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(TEMP_BIN, { force: true, recursive: true });
  });
