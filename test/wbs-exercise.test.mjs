#!/usr/bin/env node

// Runs the launcher against a local copy of the plugin repository with a
// `stable` branch, so the test needs no network. CLAUDE_CONFIG_DIR points at
// a scratch folder, so a plugin installed on this machine plays no part.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const launcher = fileURLToPath(new URL("../bin/wbs-exercise.mjs", import.meta.url));
// The plugin checkout to copy; by default the sibling directory.
const source = process.env.PLUGIN_CHECKOUT ?? fileURLToPath(new URL("../../wbs-cs", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "wbs-exercise-test-"));
const repo = join(scratch, "plugin");

// A stand-in `claude` that logs its arguments. `plugin update` succeeds by
// pointing installed_plugins.json at the "updated" install, unless FAKE_CLAUDE_FAIL
// is set. It is a Node script with a wrapper per platform: `claude` for sh,
// `claude.cmd` for the cmd.exe the launcher uses on Windows.
const fakeBin = join(scratch, "bin");
const claudeLog = join(scratch, "claude.log");
mkdirSync(fakeBin);
writeFileSync(
  join(fakeBin, "claude.mjs"),
  `import { appendFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(claudeLog)}, args.join(" ") + "\\n");
if (process.env.FAKE_CLAUDE_FAIL) process.exit(1);
if (args[1] === "update") {
  copyFileSync(process.env.UPDATED_PLUGINS_JSON, join(process.env.CLAUDE_CONFIG_DIR, "plugins", "installed_plugins.json"));
}
`,
);
writeFileSync(join(fakeBin, "claude"), `#!/bin/sh\nexec node "$(dirname "$0")/claude.mjs" "$@"\n`);
chmodSync(join(fakeBin, "claude"), 0o755);
writeFileSync(join(fakeBin, "claude.cmd"), `@node "%~dp0claude.mjs" %*\r\n`);
// Windows spells it Path; adding a second PATH key would be ignored there.
const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";

let releasedVersion;
const release = (version) => `data:application/json,${JSON.stringify({ version })}`;

function run(args, { config = join(scratch, "no-claude"), gitRepo = repo, env = {} } = {}) {
  return spawnSync(process.execPath, [launcher, ...args], {
    cwd: scratch,
    encoding: "utf8",
    env: {
      ...process.env,
      [pathKey]: `${fakeBin}${delimiter}${process.env[pathKey]}`,
      WBS_EXERCISE_REPO: gitRepo,
      WBS_EXERCISE_RELEASE_URL: release(releasedVersion),
      CLAUDE_CONFIG_DIR: config,
      ...env,
    },
  });
}

// Writes a fake plugin install and returns the installed_plugins.json content
// that points at it. A real install does not have the exercise/ folder level.
function fakeInstall(version, { without } = {}) {
  const install = join(scratch, "claude", "plugins", "cache", "wbs-cs", "exercise", version);
  cpSync(join(repo, "exercise"), install, { recursive: true });
  if (without) rmSync(join(install, "exercises", without), { recursive: true });
  const manifest = join(install, ".claude-plugin", "plugin.json");
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), version }));
  return JSON.stringify({ version: 2, plugins: { "exercise@wbs-cs": [{ scope: "user", installPath: install }] } });
}

try {
  execFileSync("git", ["clone", "--quiet", source, repo]);
  execFileSync("git", ["-C", repo, "branch", "-f", "stable", "HEAD"]);
  releasedVersion = JSON.parse(readFileSync(join(repo, "exercise", ".claude-plugin", "plugin.json"), "utf8")).version;

  // Git route: no plugin installed.
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

  // Installed route: an install of the released version that lacks movie-diary.
  const pluginsJson = join(scratch, "claude", "plugins", "installed_plugins.json");
  writeFileSync(pluginsJson, fakeInstall(releasedVersion, { without: "movie-diary" }));
  const installed = { config: join(scratch, "claude") };

  // A repository that does not exist proves the installed copy needs no git.
  const local = run(["art-explorer", "art"], { ...installed, gitRepo: join(scratch, "missing") });
  assert.equal(local.status, 0, local.stderr);
  assert.match(local.stderr, /using the installed Claude Code plugin/);
  assert.ok(existsSync(join(scratch, "art", ".gitignore")));
  assert.ok(!existsSync(claudeLog), "an up-to-date install must not be updated");

  // An exercise the installed plugin lacks comes from git instead.
  const newer = run(["movie-diary", "diary-2"], installed);
  assert.equal(newer.status, 0, newer.stderr);
  assert.doesNotMatch(newer.stderr, /using the installed/);
  assert.ok(existsSync(join(scratch, "diary-2", ".gitignore")));

  // Offline: the release cannot be checked, so the install is used as it is.
  const offline = run(["art-explorer", "art-offline"], {
    ...installed,
    gitRepo: join(scratch, "missing"),
    env: { WBS_EXERCISE_RELEASE_URL: "http://127.0.0.1:9/plugin.json" },
  });
  assert.equal(offline.status, 0, offline.stderr);
  assert.match(offline.stderr, /could not check for a newer release/);

  // An older install is updated through Claude Code, and the updated copy runs.
  writeFileSync(pluginsJson, fakeInstall("0.0.1"));
  const updatedJson = join(scratch, "updated.json");
  writeFileSync(updatedJson, fakeInstall(releasedVersion));
  const update = run(["art-explorer", "art-updated"], {
    ...installed,
    gitRepo: join(scratch, "missing"),
    env: { UPDATED_PLUGINS_JSON: updatedJson },
  });
  assert.equal(update.status, 0, update.stderr);
  assert.match(update.stderr, /updating the Claude Code plugin from 0\.0\.1/);
  assert.match(update.stderr, new RegExp(`using the installed Claude Code plugin at .*${releasedVersion.replaceAll(".", "\\.")}`));
  assert.deepEqual(readFileSync(claudeLog, "utf8").trim().split(/\r?\n/), [
    "plugin marketplace update wbs-cs",
    "plugin update exercise@wbs-cs",
  ]);

  // A failed update falls back to git.
  writeFileSync(pluginsJson, fakeInstall("0.0.1"));
  const failed = run(["art-explorer", "art-failed"], { ...installed, env: { FAKE_CLAUDE_FAIL: "1" } });
  assert.equal(failed.status, 0, failed.stderr);
  assert.match(failed.stderr, /update did not work; downloading/);
  assert.ok(existsSync(join(scratch, "art-failed", ".gitignore")));

  // An unreadable installed_plugins.json falls back to git, too.
  writeFileSync(pluginsJson, "not json");
  assert.equal(run(["art-explorer", "art-2"], installed).status, 0);

  console.log("wbs-exercise ok");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
