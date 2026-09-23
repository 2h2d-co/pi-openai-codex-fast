import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Resolves the package archive under test. A supplied candidate (`PI_PACKAGE_ARCHIVE`) is
 * resolved from the current working directory and must be an existing regular file. It never
 * falls back to packing. Without a candidate, packs the worktree at `root` into `temporary`.
 */
export async function packageArchive(
  root: string,
  temporary: string,
  supplied: string | undefined,
): Promise<string> {
  if (supplied !== undefined) {
    assert.ok(supplied.length > 0, "PI_PACKAGE_ARCHIVE must not be empty.");
    const candidate = resolve(supplied);
    assert.ok(
      (await stat(candidate)).isFile(),
      `PI_PACKAGE_ARCHIVE ${candidate} is not a regular file.`,
    );
    return realpath(candidate);
  }
  const packed: unknown = JSON.parse(
    execFileSync(
      "npm",
      [
        "pack",
        "--json",
        "--ignore-scripts",
        "--allow-directory=all",
        "--pack-destination",
        temporary,
      ],
      { cwd: root, encoding: "utf8" },
    ),
  );
  assert.ok(Array.isArray(packed) && packed.length === 1, "npm pack must report one archive.");
  const result: unknown = packed[0];
  assert.ok(
    typeof result === "object" &&
      result !== null &&
      "filename" in result &&
      typeof result.filename === "string",
    "npm pack must report the archive filename.",
  );
  return join(temporary, result.filename);
}

/** Lists the archive entries in sorted order. Fails for content that is not a gzip tar archive. */
export function archiveEntries(archive: string): string[] {
  return execFileSync("tar", ["-tzf", archive], { encoding: "utf8", stdio: "pipe" })
    .trim()
    .split("\n")
    .sort();
}
