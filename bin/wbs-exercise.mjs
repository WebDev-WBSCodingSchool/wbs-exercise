#!/usr/bin/env node

// Sets up a WBS exercise with the plugin's own setup script. If the Claude Code
// plugin is installed, it runs the installed copy, updating the plugin first when
// a newer release exists, so the project matches what /exercise:setup creates
// on this machine. When there is no usable install, it
// fetches the script and catalog from the plugin repository's `stable` branch,
// the branch the plugin installs from. This package holds no exercises itself,
// so it never needs a new release when the exercises change.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Both overrides exist for the test, to avoid GitHub.
const repo = process.env.WBS_EXERCISE_REPO ?? "https://github.com/WebDev-WBSCodingSchool/claude-code-plugin.git";
const releaseUrl =
  process.env.WBS_EXERCISE_RELEASE_URL ??
  "https://raw.githubusercontent.com/WebDev-WBSCodingSchool/claude-code-plugin/stable/exercise/.claude-plugin/plugin.json";
const args = process.argv.slice(2);

if (!args.length || args.length > 2 || (args[0] === "list" && args.length > 1)) {
  console.error("usage: npx wbs-exercise list");
  console.error("       npx wbs-exercise <exercise-id> [target-directory]");
  process.exit(2);
}

// The installed plugin as { path, version }, or undefined. installed_plugins.json
// is Claude Code's own bookkeeping, not a public format, so anything unexpected
// in it or in the install, such as an unreadable plugin.json, means "not
// installed" and the git route takes over.
function installedPlugin() {
  try {
    const config = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
    const installed = JSON.parse(readFileSync(join(config, "plugins", "installed_plugins.json"), "utf8"));
    const path = installed.plugins["exercise@wbs-cs"]
      .map(({ installPath }) => installPath)
      .find((path) => existsSync(join(path, "scripts", "setup.mjs")) && existsSync(join(path, ".claude-plugin", "plugin.json")));
    if (!path) return undefined;
    const { version } = JSON.parse(readFileSync(join(path, ".claude-plugin", "plugin.json"), "utf8"));
    return { path, version };
  } catch {
    return undefined;
  }
}

// The version on `stable`, or undefined when it cannot be read, for example offline.
async function releasedVersion() {
  try {
    const response = await fetch(releaseUrl, { signal: AbortSignal.timeout(5000) });
    return response.ok ? (await response.json()).version : undefined;
  } catch {
    return undefined;
  }
}

// Runs a Claude Code command. stdin is closed so a confirmation prompt fails the
// command instead of waiting forever; the caller then falls back to git. On
// Windows, `claude` can be claude.exe or npm's claude.cmd, and only cmd.exe
// finds both. The arguments are fixed words, so nothing needs quoting.
function claude(claudeArgs) {
  const [command, commandArgs] =
    process.platform === "win32" ? ["cmd.exe", ["/d", "/s", "/c", "claude", ...claudeArgs]] : ["claude", claudeArgs];
  const result = spawnSync(command, commandArgs, { stdio: ["ignore", "inherit", "inherit"] });
  return result.status === 0;
}

// The installed plugin, updated to the released version when it is behind, or
// undefined when there is no install or the update did not work. `current` is
// true when the install is known to match `stable`.
async function currentPlugin() {
  const plugin = installedPlugin();
  if (!plugin) return undefined;
  const released = await releasedVersion();
  if (!released) {
    console.error("wbs-exercise: could not check for a newer release; using the installed plugin as it is");
    return plugin;
  }
  if (plugin.version === released) return { ...plugin, current: true };

  console.error(`wbs-exercise: updating the Claude Code plugin from ${plugin.version} to ${released}`);
  const updated =
    claude(["plugin", "marketplace", "update", "wbs-cs"]) && claude(["plugin", "update", "exercise@wbs-cs"]) && installedPlugin();
  if (updated?.version === released) {
    console.error("wbs-exercise: restart any open Claude Code session to use the new version there");
    return { ...updated, current: true };
  }
  console.error("wbs-exercise: the update did not work; downloading the exercises instead");
  return undefined;
}

function git(gitArgs) {
  const result = spawnSync("git", gitArgs, { stdio: "inherit" });
  if (result.error) throw new Error(`could not run git (${result.error.code}); install Git and try again`);
  if (result.status !== 0) throw new Error(`could not download the exercises from ${repo}`);
}

// Downloads only what setup.mjs reads: its scripts, the shared runtime, every
// exercise's manifest (for the catalog), and the one exercise being set up.
// --filter=blob:none skips file contents until the sparse checkout asks for
// them, so the download stays small however many exercises the repo holds.
function download(checkout) {
  const paths = [
    "/exercise/.claude-plugin/",
    "/exercise/scripts/",
    "/exercise/runtime/",
    "/exercise/exercises/curriculum.json",
    "/exercise/exercises/*/exercise.json",
    ...(args[0] === "list" ? [] : [`/exercise/exercises/${args[0]}/`]),
  ];
  // Git for Windows turns LF into CRLF on checkout by default, which would hand
  // setup a pre-commit shell script that sh cannot run. Keep the repo's bytes.
  git(["clone", "--quiet", "-c", "core.autocrlf=false", "--depth", "1", "--filter=blob:none", "--sparse", "--branch", "stable", repo, checkout]);
  git(["-C", checkout, "sparse-checkout", "set", "--no-cone", ...paths]);
  return join(checkout, "exercise");
}

let checkout;
let status = 1;
try {
  const plugin = await currentPlugin();
  let root = plugin?.path;
  // An exercise newer than an unchecked install is only on GitHub. An install
  // that matches `stable` has them all, so its setup.mjs reports the unknown name.
  if (plugin && !plugin.current && args[0] !== "list" && !existsSync(join(root, "exercises", args[0], "exercise.json"))) {
    root = undefined;
  }
  if (root) {
    console.error(`wbs-exercise: using the installed Claude Code plugin at ${root}`);
  } else {
    checkout = mkdtempSync(join(tmpdir(), "wbs-exercise-"));
    root = download(checkout);
  }

  // setup.mjs resolves the target directory against the current directory, so
  // the project lands where the student ran the command, not in the plugin.
  const command = args[0] === "list" ? ["list"] : ["setup", ...args];
  status = spawnSync(process.execPath, [join(root, "scripts", "setup.mjs"), ...command], { stdio: "inherit" }).status ?? 1;
} catch (error) {
  console.error(`wbs-exercise: ${error.message}`);
} finally {
  // Retries, because Windows virus scanners briefly lock freshly written files.
  if (checkout) rmSync(checkout, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(status);
