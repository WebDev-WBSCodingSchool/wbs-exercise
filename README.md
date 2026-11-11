# wbs-exercise

Sets up a WBS Coding School exercise from a terminal, without Claude Code. You
need Node.js 22 or newer and Git.

```sh
npx wbs-exercise list
npx wbs-exercise art-explorer
npx wbs-exercise art-explorer ./my-art-explorer
```

The command runs the same setup script as the plugin's `/exercise:setup`, so it
creates the same project. Then open Claude Code in the new folder and run
`/onboard`.

Where the script comes from depends on what is installed:

- If the `exercise` Claude Code plugin is installed, the command uses it. When a
  newer release exists, it first updates the plugin with
  `claude plugin marketplace update wbs-cs` and
  `claude plugin update exercise@wbs-cs`. Offline, it uses the installed version
  as it is.
- If the plugin is not installed, the update fails, or the installed version
  lacks the exercise, the command downloads only the files it needs from the
  `stable` branch of
  [WebDev-WBSCodingSchool/claude-code-plugin](https://github.com/WebDev-WBSCodingSchool/claude-code-plugin).

This package contains only the launcher. New or changed exercises reach students
through the plugin repository's release, not through a new version of this
package.

## Development

`npm test` runs the launcher against a local copy of the plugin repository,
by default `../wbs-cs`. Set `PLUGIN_CHECKOUT` to use another path. The test
uses a fake `claude` command and its own `CLAUDE_CONFIG_DIR`, so it never touches
a plugin installed on your machine, and it needs no network. It needs a POSIX
shell for the fake `claude`.

`npm run test:e2e` tests what students actually run. It packs the package, runs
it through `npx` against the real `stable` branch, and checks that each project
it creates is file-for-file identical to the one the plugin's own `setup.mjs`
creates. With `claude` on PATH, it also installs the real plugin into a
throwaway `CLAUDE_CONFIG_DIR` and tests the installed, offline and update routes.
It needs the network, takes about a minute, and leaves nothing behind.
`E2E_EXERCISES=movie-diary,art-explorer` limits it to some exercises, and
`E2E_REQUIRE_CLAUDE=1` makes a missing `claude` a failure instead of a skip.

`.github/workflows/test.yml` runs both tests on every push, weekly, and on
demand, on Linux and macOS.
