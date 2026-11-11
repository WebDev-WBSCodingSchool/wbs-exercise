#!/usr/bin/env node

// End-to-end test of the published path: packs this package, runs it through
// `npx` against the real `stable` branch on GitHub, and checks that every project
// it creates is identical to the one the plugin's own setup.mjs creates. With a
// `claude` CLI on PATH, it also installs the real plugin into a throwaway
// CLAUDE_CONFIG_DIR and tests the installed and update routes.
//
// Needs the network. Nothing on this machine is touched: npm, Claude Code and
// the projects all live in one temporary folder.
//
//   npm run test:e2e
//   E2E_EXERCISES=movie-diary,art-explorer npm run test:e2e   # only these
//   E2E_REQUIRE_CLAUDE=1 npm run test:e2e                     # fail without claude
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const repo = "https://github.com/WebDev-WBSCodingSchool/claude-code-plugin.git";
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "wbs-exercise-e2e-"));
const windows = process.platform === "win32";

// An own npm cache, so npx installs the fresh tarball instead of a cached copy.
const baseEnv = { ...process.env, npm_config_cache: join(scratch, "npm-cache"), npm_config_update_notifier: "false" };
delete baseEnv.WBS_EXERCISE_REPO;
delete baseEnv.WBS_EXERCISE_RELEASE_URL;

function run(command, args, { cwd = scratch, env = {} } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...baseEnv, ...env } });
  if (result.error) throw result.error;
  return result;
}

// npm and npx are .cmd files on Windows, which need a shell, and a shell
// splits paths with spaces. Under `npm run`, npm_execpath names npm's own
// script, so both run through node directly on every platform.
const npmCli = process.env.npm_execpath;
const npm = (args, options) => (npmCli ? run(process.execPath, [npmCli, ...args], options) : run("npm", args, options));
const npx = (args, options) =>
  npmCli ? run(process.execPath, [join(dirname(npmCli), "npx-cli.js"), ...args], options) : run("npx", args, options);

// cmd.exe finds claude.exe and npm's claude.cmd alike; the arguments are fixed words.
const claudeCli = (args, options) =>
  windows ? run("cmd.exe", ["/d", "/s", "/c", "claude", ...args], options) : run("claude", args, options);

function ok(result, what) {
  assert.equal(result.status, 0, `${what} failed:\n${result.stdout}\n${result.stderr}`);
  return result;
}

let tarball;
function launch(args, { cwd, config, env = {} }) {
  return npx(["--yes", "--package", tarball, "wbs-exercise", ...args], { cwd, env: { CLAUDE_CONFIG_DIR: config, ...env } });
}

// What a project's first commit contains, as one hash: two projects with the
// same tree hash have exactly the same files with the same contents.
function tree(project) {
  return execFileSync("git", ["-C", project, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
}

function files(project) {
  return execFileSync("git", ["-C", project, "ls-tree", "-r", "HEAD"], { encoding: "utf8" }).trim().split("\n");
}

// Asserts that `project` matches the reference project, and on a mismatch
// names the files that differ rather than two opaque hashes.
function assertSameProject(project, reference, what) {
  // git compares contents after line-ending conversion, so a CRLF hook in the
  // working folder would pass the tree check and still fail to run under sh.
  assert.ok(
    !readFileSync(join(project, ".claude", "githooks", "pre-commit"), "utf8").includes("\r"),
    `${what}: the pre-commit hook has Windows line endings, which sh cannot run`,
  );
  if (tree(project) === tree(reference)) {
    assert.equal(
      execFileSync("git", ["-C", project, "config", "--get", "core.hooksPath"], { encoding: "utf8" }).trim(),
      ".claude/githooks",
      `${what}: git hooks not configured`,
    );
    return;
  }
  const mine = new Set(files(project));
  const theirs = new Set(files(reference));
  const differ = [...mine.symmetricDifference(theirs)].map((line) => line.split("\t")[1]);
  assert.fail(`${what} differs from the plugin's own setup in:\n- ${[...new Set(differ)].join("\n- ")}`);
}

function installedPlugins(config) {
  return JSON.parse(readFileSync(join(config, "plugins", "installed_plugins.json"), "utf8"));
}

// Makes the installed plugin look like an older release: renames its folder
// and rewrites both version records, as an install of version 0.0.1 would have.
function ageInstall(config) {
  const file = join(config, "plugins", "installed_plugins.json");
  const installed = installedPlugins(config);
  const [entry] = installed.plugins["exercise@wbs-cs"];
  const older = join(entry.installPath, "..", "0.0.1");
  renameSync(entry.installPath, older);
  const manifest = join(older, ".claude-plugin", "plugin.json");
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), version: "0.0.1" }));
  Object.assign(entry, { installPath: older, version: "0.0.1" });
  writeFileSync(file, JSON.stringify(installed, null, 2));
}

const step = (name) => console.log(`- ${name}`);

try {
  step("packing the launcher");
  const packed = ok(npm(["pack", "--silent", "--pack-destination", scratch], { cwd: packageRoot }), "npm pack");
  tarball = join(scratch, packed.stdout.trim().split("\n").at(-1));

  // The reference: the plugin's own setup.mjs from a full clone of stable.
  step("building reference projects with the plugin's own setup.mjs");
  const plugin = join(scratch, "plugin");
  // Repository bytes, as the launcher checks them out; see its clone comment.
  ok(run("git", ["clone", "--quiet", "-c", "core.autocrlf=false", "--depth", "1", "--branch", "stable", repo, plugin]), "git clone");
  const setup = join(plugin, "exercise", "scripts", "setup.mjs");
  const referenceList = ok(run(process.execPath, [setup, "list"]), "setup list").stdout;
  const all = referenceList.trim().split("\n").map((line) => line.split("\t")[0]);
  const exercises = process.env.E2E_EXERCISES ? process.env.E2E_EXERCISES.split(",") : all;
  for (const id of exercises) assert.ok(all.includes(id), `E2E_EXERCISES names unknown exercise "${id}"`);

  const reference = join(scratch, "reference");
  mkdirSync(reference);
  for (const id of exercises) ok(run(process.execPath, [setup, "setup", id], { cwd: reference }), `reference ${id}`);

  // Git route: no Claude Code at all.
  step("git route: no plugin installed");
  const noClaude = join(scratch, "no-claude");
  const viaGit = join(scratch, "via-git");
  mkdirSync(viaGit);
  const list = ok(launch(["list"], { cwd: viaGit, config: noClaude }), "list");
  assert.equal(list.stdout, referenceList);
  for (const id of exercises) {
    const created = ok(launch([id], { cwd: viaGit, config: noClaude }), `git route ${id}`);
    assert.doesNotMatch(created.stderr, /using the installed/);
    assertSameProject(join(viaGit, id), join(reference, id), `git route ${id}`);
    console.log(`  ok ${id}`);
  }

  let claude;
  try {
    claude = claudeCli(["--version"]);
  } catch {
    claude = { status: 1 };
  }
  if (claude.status !== 0) {
    if (process.env.E2E_REQUIRE_CLAUDE) assert.fail("E2E_REQUIRE_CLAUDE is set, but `claude` is not on PATH");
    console.log("SKIP installed and update routes: no `claude` CLI on PATH");
  } else {
    // The installed routes need only one exercise; the files are the same.
    const [id] = exercises;
    const config = join(scratch, "claude");
    const env = { CLAUDE_CONFIG_DIR: config };
    step(`installing the real plugin with ${claude.stdout.trim()}`);
    ok(claudeCli(["plugin", "marketplace", "add", "WebDev-WBSCodingSchool/claude-code-plugin#stable"], { env }), "marketplace add");
    ok(claudeCli(["plugin", "install", "exercise@wbs-cs"], { env }), "plugin install");
    const released = installedPlugins(config).plugins["exercise@wbs-cs"][0].version;

    // A repository that does not exist proves this route downloads nothing.
    const noGit = { WBS_EXERCISE_REPO: join(scratch, "no-such-repo") };

    step("installed route: plugin up to date");
    const viaInstall = join(scratch, "via-install");
    mkdirSync(viaInstall);
    const installed = ok(launch([id], { cwd: viaInstall, config, env: noGit }), "installed route");
    assert.match(installed.stderr, /using the installed Claude Code plugin/);
    assert.doesNotMatch(installed.stderr, /updating/);
    assertSameProject(join(viaInstall, id), join(reference, id), "installed route");

    step("installed route: release check unreachable");
    const viaOffline = join(scratch, "via-offline");
    mkdirSync(viaOffline);
    const offline = ok(
      launch([id], { cwd: viaOffline, config, env: { ...noGit, WBS_EXERCISE_RELEASE_URL: "http://127.0.0.1:9/plugin.json" } }),
      "offline route",
    );
    assert.match(offline.stderr, /could not check for a newer release/);
    assertSameProject(join(viaOffline, id), join(reference, id), "offline route");

    step("update route: plugin older than stable");
    ageInstall(config);
    const viaUpdate = join(scratch, "via-update");
    mkdirSync(viaUpdate);
    const updated = ok(launch([id], { cwd: viaUpdate, config, env: noGit }), "update route");
    assert.match(updated.stderr, new RegExp(`updating the Claude Code plugin from 0\\.0\\.1 to ${released.replaceAll(".", "\\.")}`));
    assert.match(updated.stderr, /using the installed Claude Code plugin/);
    assert.equal(installedPlugins(config).plugins["exercise@wbs-cs"][0].version, released);
    assertSameProject(join(viaUpdate, id), join(reference, id), "update route");
  }

  console.log("wbs-exercise e2e ok");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
