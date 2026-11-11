#!/usr/bin/env node

// Fetches the current exercise catalog from the plugin repository's `stable`
// branch, the branch the Claude Code plugin installs from, and runs its setup
// script. This package holds no exercises itself, so it never needs a new
// release when the exercises change.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// WBS_EXERCISE_REPO lets the test point at a local clone instead of GitHub.
const repo = process.env.WBS_EXERCISE_REPO ?? "https://github.com/WebDev-WBSCodingSchool/claude-code-plugin.git";
const args = process.argv.slice(2);

if (!args.length || args.length > 2 || (args[0] === "list" && args.length > 1)) {
  console.error("usage: npx wbs-exercise list");
  console.error("       npx wbs-exercise <exercise-id> [target-directory]");
  process.exit(2);
}

function git(gitArgs) {
  const result = spawnSync("git", gitArgs, { stdio: "inherit" });
  if (result.error) throw new Error(`could not run git (${result.error.code}); install Git and try again`);
  if (result.status !== 0) throw new Error(`could not download the exercises from ${repo}`);
}

const checkout = mkdtempSync(join(tmpdir(), "wbs-exercise-"));
let status = 1;
try {
  // Download only what setup.mjs reads: its scripts, the shared runtime, every
  // exercise's manifest (for the catalog), and the one exercise being set up.
  // --filter=blob:none skips file contents until the sparse checkout asks for
  // them, so the download stays small however many exercises the repo holds.
  const paths = [
    "/exercise/.claude-plugin/",
    "/exercise/scripts/",
    "/exercise/runtime/",
    "/exercise/exercises/curriculum.json",
    "/exercise/exercises/*/exercise.json",
    ...(args[0] === "list" ? [] : [`/exercise/exercises/${args[0]}/`]),
  ];
  git(["clone", "--quiet", "--depth", "1", "--filter=blob:none", "--sparse", "--branch", "stable", repo, checkout]);
  git(["-C", checkout, "sparse-checkout", "set", "--no-cone", ...paths]);

  // setup.mjs resolves the target directory against the current directory, so
  // the project lands where the student ran the command, not in the checkout.
  const setup = join(checkout, "exercise", "scripts", "setup.mjs");
  const command = args[0] === "list" ? ["list"] : ["setup", ...args];
  status = spawnSync(process.execPath, [setup, ...command], { stdio: "inherit" }).status ?? 1;
} catch (error) {
  console.error(`wbs-exercise: ${error.message}`);
} finally {
  rmSync(checkout, { recursive: true, force: true });
}
process.exit(status);
