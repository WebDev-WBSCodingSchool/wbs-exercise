#!/usr/bin/env node

// Runs the launcher against a local copy of the plugin repository with a
// `stable` branch, so the test needs no network.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const launcher = fileURLToPath(new URL("../bin/wbs-exercise.mjs", import.meta.url));
// The plugin checkout to copy; by default the sibling directory.
const source = process.env.PLUGIN_CHECKOUT ?? fileURLToPath(new URL("../../wbs-cs", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "wbs-exercise-test-"));

function run(args) {
  return spawnSync(process.execPath, [launcher, ...args], {
    cwd: scratch,
    encoding: "utf8",
    env: { ...process.env, WBS_EXERCISE_REPO: join(scratch, "plugin") },
  });
}

try {
  execFileSync("git", ["clone", "--quiet", source, join(scratch, "plugin")]);
  execFileSync("git", ["-C", join(scratch, "plugin"), "branch", "-f", "stable", "HEAD"]);

  const list = run(["list"]);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /^movie-diary\tMovie Diary$/m);

  // movie-diary is the exercise whose .gitignore setup verifies, so a missing
  // .gitignore fails here rather than slipping through.
  const created = run(["movie-diary", "my-diary"]);
  assert.equal(created.status, 0, created.stderr);
  assert.ok(existsSync(join(scratch, "my-diary", ".gitignore")));
  assert.ok(existsSync(join(scratch, "my-diary", ".claude", "harness", "lock.json")));

  const unknown = run(["nope"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown exercise "nope"/);

  assert.equal(run([]).status, 2);
  assert.equal(run(["list", "extra"]).status, 2);

  console.log("wbs-exercise ok");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
