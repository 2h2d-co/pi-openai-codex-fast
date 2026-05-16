#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

type RunOrder = "normal-first" | "fast-first";
type BenchmarkCase = {
  name: string;
  itemCount: number;
  pairs: number;
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
  label: string;
  model: string;
  caseName: string;
  thinkingLevel: string;
  pair: number;
  order: RunOrder;
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
type PairResult = {
  caseName: string;
  pair: number;
  order: RunOrder;
  itemCount: number;
  thinkingLevel: string;
  normal: BenchmarkResult;
  fast: BenchmarkResult;
};
type ConditionSummary = {
  count: number;
  medianWallMs: number | null;
  medianFirstAssistantUpdateMs: number | null;
  medianFirstThinkingDeltaMs: number | null;
  medianFirstTextDeltaMs: number | null;
  medianWallOutputTokensPerSecond: number | null;
  medianTextStreamOutputTokensPerSecond: number | null;
  medianOutputTokens: number | null;
  medianTotalTokens: number | null;
  medianCacheReadTokens: number | null;
  medianCacheWriteTokens: number | null;
  medianObservedCostMultiplier: number | null;
  exactMatchCount: number;
};
type PairedSummary = {
  pairs: number;
  fastWinsWall: number;
  fastWinsFirstText: number;
  fastWinsWallThroughput: number;
  fastWinsTextStreamThroughput: number;
  medianWallImprovementPct: number | null;
  medianFirstTextImprovementPct: number | null;
  medianWallThroughputImprovementPct: number | null;
  medianTextStreamThroughputImprovementPct: number | null;
};
type CaseReport = {
  name: string;
  itemCount: number;
  thinkingLevel: string;
  pairs: PairResult[];
  summary: { normal: ConditionSummary; fast: ConditionSummary; paired: PairedSummary };
};
type Report = {
  createdAt: string;
  benchmarkTarget: string;
  normalModel: string;
  fastModel: string;
  cases: CaseReport[];
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");
const MODEL_ID = process.env.MODEL_ID ?? "gpt-5.5";
const NORMAL_MODEL = `openai-codex/${MODEL_ID}`;
const FAST_MODEL = `openai-codex-fast/${MODEL_ID}`;
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? "300000");
const RESULTS_PATH = join(__dirname, "results.json");
const SUMMARY_PATH = join(__dirname, "summary.md");
const BASE_PRICING = { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 };
const SYSTEM_PROMPT =
  "You are a deterministic sorter. Obey the requested output format exactly and provide no commentary.";
const ITEM_COUNT = Number(process.env.ITEM_COUNT ?? "200");
const PAIRS_PER_LEVEL = Number(process.env.PAIRS_PER_LEVEL ?? "5");
const LEVELS = (process.env.LEVELS ?? "off,minimal,low,medium,high,xhigh")
  .split(",")
  .map((level) => level.trim())
  .filter(Boolean);
const ORIGINAL_PATH = process.env.PATH ?? "";
const TEMP_BIN = mkdtempSync(join(tmpdir(), "pi-openai-codex-fast-bench-"));

function findPi(): string {
  const result = spawnSync("sh", ["-lc", "command -v pi"], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error("Could not find pi in PATH");
  return result.stdout.trim();
}

function installPiWrapper(): void {
  const realPi = process.env.PI_BIN ?? findPi();
  writeFileSync(
    join(TEMP_BIN, "pi"),
    `#!/usr/bin/env node\nimport { spawnSync } from "node:child_process";\nconst result = spawnSync(${JSON.stringify(realPi)}, ["-e", ${JSON.stringify(ROOT)}, ...process.argv.slice(2)], { stdio: "inherit" });\nif (result.error) throw result.error;\nprocess.exit(result.status ?? 1);\n`,
    "utf8",
  );
  chmodSync(join(TEMP_BIN, "pi"), 0o755);
}

function labelLines(caseName: string, itemCount: number, pair: number): string[] {
  const run = String(pair).padStart(2, "0");
  return Array.from(
    { length: itemCount },
    (_, index) => `${caseName}-run-${run}-item-${String(index + 1).padStart(4, "0")}`,
  );
}

function scrambleLabels(labels: string[], pair: number): string[] {
  const step = labels.length - 1;
  return Array.from(
    { length: labels.length },
    (_, index) => labels[(index * step + pair) % labels.length]!,
  );
}

function buildSorterPrompt(sortedLabels: string[], pair: number): string {
  return [
    `You are given ${sortedLabels.length} labels in scrambled order.`,
    "Output the exact same labels sorted in ascending lexicographic order, one label per line.",
    "Do not omit any labels. Do not add commentary, bullets, numbering, blank lines, or code fences.",
    "Scrambled labels:",
    scrambleLabels(sortedLabels, pair).join("\n"),
  ].join("\n\n");
}

function buildTrial(benchmarkCase: BenchmarkCase, pair: number): Trial {
  const expectedLines = labelLines(benchmarkCase.name, benchmarkCase.itemCount, pair);
  return {
    expectedText: expectedLines.join("\n"),
    prompt: buildSorterPrompt(expectedLines, pair),
  };
}

function round(value: number | null | undefined, digits = 2): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function median(values: Array<number | null | undefined>): number | null {
  const sorted = values
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
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

function buildPiArgs(model: string, benchmarkCase: BenchmarkCase, prompt: string): string[] {
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
    benchmarkCase.systemPrompt,
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
  label: string,
  model: string,
  benchmarkCase: BenchmarkCase,
  pair: number,
  order: RunOrder,
  trial: Trial,
): Promise<BenchmarkResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("pi", buildPiArgs(model, benchmarkCase, trial.prompt), {
      cwd: process.env.PI_BENCH_CWD ?? process.cwd(),
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
        thinkingLevel: benchmarkCase.thinkingLevel,
        pair,
        order,
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

async function runPair(benchmarkCase: BenchmarkCase, pairIndex: number): Promise<PairResult> {
  const order: RunOrder = pairIndex % 2 === 0 ? "fast-first" : "normal-first";
  const trial = buildTrial(benchmarkCase, pairIndex);
  let normal: BenchmarkResult;
  let fast: BenchmarkResult;

  if (order === "normal-first") {
    normal = await runPiOnce("normal", NORMAL_MODEL, benchmarkCase, pairIndex, order, trial);
    fast = await runPiOnce("fast", FAST_MODEL, benchmarkCase, pairIndex, order, trial);
  } else {
    fast = await runPiOnce("fast", FAST_MODEL, benchmarkCase, pairIndex, order, trial);
    normal = await runPiOnce("normal", NORMAL_MODEL, benchmarkCase, pairIndex, order, trial);
  }

  return {
    caseName: benchmarkCase.name,
    pair: pairIndex,
    order,
    itemCount: benchmarkCase.itemCount,
    thinkingLevel: benchmarkCase.thinkingLevel,
    normal,
    fast,
  };
}

function summarizeCondition(results: BenchmarkResult[]): ConditionSummary {
  return {
    count: results.length,
    medianWallMs: round(median(results.map((result) => result.wallMs))),
    medianFirstAssistantUpdateMs: round(
      median(results.map((result) => result.firstAssistantUpdateMs)),
    ),
    medianFirstThinkingDeltaMs: round(median(results.map((result) => result.firstThinkingDeltaMs))),
    medianFirstTextDeltaMs: round(median(results.map((result) => result.firstTextDeltaMs))),
    medianWallOutputTokensPerSecond: round(
      median(results.map((result) => result.wallOutputTokensPerSecond)),
    ),
    medianTextStreamOutputTokensPerSecond: round(
      median(results.map((result) => result.textStreamOutputTokensPerSecond)),
    ),
    medianOutputTokens: round(median(results.map((result) => result.outputTokens)), 0),
    medianTotalTokens: round(median(results.map((result) => result.totalTokens)), 0),
    medianCacheReadTokens: round(median(results.map((result) => result.cacheReadTokens)), 0),
    medianCacheWriteTokens: round(median(results.map((result) => result.cacheWriteTokens)), 0),
    medianObservedCostMultiplier: round(
      median(results.map((result) => result.observedCostMultiplier)),
      3,
    ),
    exactMatchCount: results.filter((result) => result.exactMatched).length,
  };
}

function summarizePairs(pairs: PairResult[]): PairedSummary {
  const wallImprovements = pairs.map((pair) => percentChange(pair.normal.wallMs, pair.fast.wallMs));
  const firstTextImprovements = pairs.map((pair) =>
    percentChange(pair.normal.firstTextDeltaMs, pair.fast.firstTextDeltaMs),
  );
  const wallThroughputImprovements = pairs.map((pair) =>
    percentChange(pair.normal.wallOutputTokensPerSecond, pair.fast.wallOutputTokensPerSecond),
  );
  const textStreamThroughputImprovements = pairs.map((pair) =>
    percentChange(
      pair.normal.textStreamOutputTokensPerSecond,
      pair.fast.textStreamOutputTokensPerSecond,
    ),
  );
  return {
    pairs: pairs.length,
    fastWinsWall: pairs.filter((pair) => pair.fast.wallMs < pair.normal.wallMs).length,
    fastWinsFirstText: pairs.filter(
      (pair) =>
        pair.fast.firstTextDeltaMs !== null &&
        pair.normal.firstTextDeltaMs !== null &&
        pair.fast.firstTextDeltaMs < pair.normal.firstTextDeltaMs,
    ).length,
    fastWinsWallThroughput: pairs.filter(
      (pair) => pair.fast.wallOutputTokensPerSecond > pair.normal.wallOutputTokensPerSecond,
    ).length,
    fastWinsTextStreamThroughput: pairs.filter(
      (pair) =>
        pair.fast.textStreamOutputTokensPerSecond !== null &&
        pair.normal.textStreamOutputTokensPerSecond !== null &&
        pair.fast.textStreamOutputTokensPerSecond > pair.normal.textStreamOutputTokensPerSecond,
    ).length,
    medianWallImprovementPct: round(median(wallImprovements)),
    medianFirstTextImprovementPct: round(median(firstTextImprovements)),
    medianWallThroughputImprovementPct: round(median(wallThroughputImprovements)),
    medianTextStreamThroughputImprovementPct: round(median(textStreamThroughputImprovements)),
  };
}

async function runCase(benchmarkCase: BenchmarkCase): Promise<CaseReport> {
  console.log(
    `\n${benchmarkCase.name}: ${benchmarkCase.itemCount} lines, thinking=${benchmarkCase.thinkingLevel}, ${benchmarkCase.pairs} paired runs`,
  );
  const pairs: PairResult[] = [];
  for (let pairIndex = 1; pairIndex <= benchmarkCase.pairs; pairIndex += 1) {
    const pair = await runPair(benchmarkCase, pairIndex);
    pairs.push(pair);
    console.log(
      [
        `pair ${pairIndex} ${pair.order}`,
        `normal wall=${round(pair.normal.wallMs, 0)}ms text=${round(pair.normal.firstTextDeltaMs, 0)}ms think=${round(pair.normal.firstThinkingDeltaMs, 0)}ms wall_tps=${round(pair.normal.wallOutputTokensPerSecond)} cache=${pair.normal.cacheReadTokens}/${pair.normal.cacheWriteTokens} exact=${pair.normal.exactMatched ? "yes" : "no"}`,
        `fast wall=${round(pair.fast.wallMs, 0)}ms text=${round(pair.fast.firstTextDeltaMs, 0)}ms think=${round(pair.fast.firstThinkingDeltaMs, 0)}ms wall_tps=${round(pair.fast.wallOutputTokensPerSecond)} cache=${pair.fast.cacheReadTokens}/${pair.fast.cacheWriteTokens} exact=${pair.fast.exactMatched ? "yes" : "no"}`,
      ].join(" | "),
    );
  }
  return {
    name: benchmarkCase.name,
    itemCount: benchmarkCase.itemCount,
    thinkingLevel: benchmarkCase.thinkingLevel,
    pairs,
    summary: {
      normal: summarizeCondition(pairs.map((pair) => pair.normal)),
      fast: summarizeCondition(pairs.map((pair) => pair.fast)),
      paired: summarizePairs(pairs),
    },
  };
}

function buildMarkdownSummary(report: Report): string {
  const lines: string[] = [];
  lines.push("# OpenAI Codex Fast benchmark summary");
  lines.push("");
  lines.push(`- Generated: ${report.createdAt}`);
  lines.push(`- Target: ${report.benchmarkTarget}`);
  lines.push(`- Normal model: \`${report.normalModel}\``);
  lines.push(`- Fast model: \`${report.fastModel}\``);
  lines.push("- Runs are sequential paired runs with alternating order.");
  lines.push("- Prompts vary by pair; each normal/fast pair receives the same prompt.");
  lines.push("");
  for (const benchmarkCase of report.cases) {
    lines.push(
      `## ${benchmarkCase.name} (${benchmarkCase.itemCount} lines, thinking=\`${benchmarkCase.thinkingLevel}\`, ${benchmarkCase.summary.paired.pairs} pairs)`,
    );
    lines.push("");
    lines.push("Validation: exact text match.");
    lines.push("");
    lines.push("| Metric | Normal | Fast | Paired median change |");
    lines.push("|---|---:|---:|---:|");
    lines.push(
      `| Wall time | ${benchmarkCase.summary.normal.medianWallMs} ms | ${benchmarkCase.summary.fast.medianWallMs} ms | ${benchmarkCase.summary.paired.medianWallImprovementPct}% |`,
    );
    lines.push(
      `| First assistant update | ${benchmarkCase.summary.normal.medianFirstAssistantUpdateMs} ms | ${benchmarkCase.summary.fast.medianFirstAssistantUpdateMs} ms | — |`,
    );
    lines.push(
      `| First thinking delta | ${benchmarkCase.summary.normal.medianFirstThinkingDeltaMs} ms | ${benchmarkCase.summary.fast.medianFirstThinkingDeltaMs} ms | — |`,
    );
    lines.push(
      `| First visible text | ${benchmarkCase.summary.normal.medianFirstTextDeltaMs} ms | ${benchmarkCase.summary.fast.medianFirstTextDeltaMs} ms | ${benchmarkCase.summary.paired.medianFirstTextImprovementPct}% |`,
    );
    lines.push(
      `| Wall output tok/s | ${benchmarkCase.summary.normal.medianWallOutputTokensPerSecond} | ${benchmarkCase.summary.fast.medianWallOutputTokensPerSecond} | ${benchmarkCase.summary.paired.medianWallThroughputImprovementPct}% |`,
    );
    lines.push(
      `| Text-stream output tok/s | ${benchmarkCase.summary.normal.medianTextStreamOutputTokensPerSecond} | ${benchmarkCase.summary.fast.medianTextStreamOutputTokensPerSecond} | ${benchmarkCase.summary.paired.medianTextStreamThroughputImprovementPct}% |`,
    );
    lines.push(
      `| Output tokens | ${benchmarkCase.summary.normal.medianOutputTokens} | ${benchmarkCase.summary.fast.medianOutputTokens} | — |`,
    );
    lines.push(
      `| Total tokens | ${benchmarkCase.summary.normal.medianTotalTokens} | ${benchmarkCase.summary.fast.medianTotalTokens} | — |`,
    );
    lines.push(
      `| Cache read tokens | ${benchmarkCase.summary.normal.medianCacheReadTokens} | ${benchmarkCase.summary.fast.medianCacheReadTokens} | — |`,
    );
    lines.push(
      `| Cache write tokens | ${benchmarkCase.summary.normal.medianCacheWriteTokens} | ${benchmarkCase.summary.fast.medianCacheWriteTokens} | — |`,
    );
    lines.push(
      `| Observed cost multiplier | ${benchmarkCase.summary.normal.medianObservedCostMultiplier}x | ${benchmarkCase.summary.fast.medianObservedCostMultiplier}x | — |`,
    );
    lines.push(
      `| Exact matches | ${benchmarkCase.summary.normal.exactMatchCount}/${benchmarkCase.summary.normal.count} | ${benchmarkCase.summary.fast.exactMatchCount}/${benchmarkCase.summary.fast.count} | — |`,
    );
    lines.push("");
    lines.push(
      `Fast wins: wall ${benchmarkCase.summary.paired.fastWinsWall}/${benchmarkCase.summary.paired.pairs}, first visible text ${benchmarkCase.summary.paired.fastWinsFirstText}/${benchmarkCase.summary.paired.pairs}, wall throughput ${benchmarkCase.summary.paired.fastWinsWallThroughput}/${benchmarkCase.summary.paired.pairs}, text-stream throughput ${benchmarkCase.summary.paired.fastWinsTextStreamThroughput}/${benchmarkCase.summary.paired.pairs}.`,
    );
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  installPiWrapper();
  console.log(`Normal model: ${NORMAL_MODEL}`);
  console.log(`Fast model:   ${FAST_MODEL}`);

  const benchmarkCases = LEVELS.map(
    (level): BenchmarkCase => ({
      name: level,
      itemCount: ITEM_COUNT,
      pairs: PAIRS_PER_LEVEL,
      thinkingLevel: level,
      systemPrompt: SYSTEM_PROMPT,
    }),
  );

  const caseReports: CaseReport[] = [];
  for (const benchmarkCase of benchmarkCases) {
    caseReports.push(await runCase(benchmarkCase));
  }

  const report: Report = {
    createdAt: new Date().toISOString(),
    benchmarkTarget: "Pi CLI end-to-end latency, including process startup and JSON streaming",
    normalModel: NORMAL_MODEL,
    fastModel: FAST_MODEL,
    cases: caseReports,
  };

  await writeFile(RESULTS_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(SUMMARY_PATH, buildMarkdownSummary(report), "utf8");

  console.log(`\nSaved raw results to ${RESULTS_PATH}`);
  console.log(`Saved summary to ${SUMMARY_PATH}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(TEMP_BIN, { force: true, recursive: true });
  });
