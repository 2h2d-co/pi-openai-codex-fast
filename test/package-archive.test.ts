import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test, { type TestContext } from "node:test";
import { archiveEntries, packageArchive } from "./package-archive.ts";

// Every temporary directory here lacks a package.json, so an accidental npm pack fails loudly.
async function temporaryDirectory(t: TestContext): Promise<string> {
  const temporary = await mkdtemp(join(tmpdir(), "fast-archive-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  return temporary;
}

test("uses an absolute candidate without packing the worktree", async (t) => {
  const temporary = await temporaryDirectory(t);
  const candidate = join(temporary, "candidate.tgz");
  await writeFile(candidate, "synthetic candidate");
  assert.equal(await packageArchive(temporary, temporary, candidate), await realpath(candidate));
  assert.equal(await readFile(candidate, "utf8"), "synthetic candidate");
  assert.deepEqual(await readdir(temporary), ["candidate.tgz"]);
});

test("resolves a relative candidate from the working directory", async (t) => {
  const temporary = await temporaryDirectory(t);
  const candidate = join(temporary, "candidate.tgz");
  await writeFile(candidate, "synthetic candidate");
  const supplied = relative(process.cwd(), candidate);
  assert.notEqual(supplied, candidate);
  assert.equal(await packageArchive(temporary, temporary, supplied), await realpath(candidate));
  assert.deepEqual(await readdir(temporary), ["candidate.tgz"]);
});

test("rejects an empty, missing, or directory candidate without falling back", async (t) => {
  const temporary = await temporaryDirectory(t);
  await mkdir(join(temporary, "directory.tgz"));
  await assert.rejects(packageArchive(temporary, temporary, ""), /must not be empty/);
  await assert.rejects(packageArchive(temporary, temporary, join(temporary, "missing.tgz")), {
    code: "ENOENT",
  });
  await assert.rejects(
    packageArchive(temporary, temporary, join(temporary, "directory.tgz")),
    /not a regular file/,
  );
  assert.deepEqual(await readdir(temporary), ["directory.tgz"]);
});

test("rejects a candidate that is not a gzip tar archive", async (t) => {
  const temporary = await temporaryDirectory(t);
  const candidate = join(temporary, "invalid.tgz");
  await writeFile(candidate, "not an archive");
  const archive = await packageArchive(temporary, temporary, candidate);
  assert.throws(() => archiveEntries(archive));
});

test("packs the worktree only when no candidate is supplied", async (t) => {
  const temporary = await temporaryDirectory(t);
  const source = join(temporary, "source");
  const output = join(temporary, "output");
  await mkdir(source);
  await mkdir(output);
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({ name: "synthetic-fast-package", version: "1.0.0" }),
  );
  const archive = await packageArchive(source, output, undefined);
  assert.equal(archive, join(output, "synthetic-fast-package-1.0.0.tgz"));
  assert.deepEqual(archiveEntries(archive), ["package/package.json"]);
});
