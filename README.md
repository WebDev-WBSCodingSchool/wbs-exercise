# wbs-exercise

Sets up a WBS Coding School exercise from a terminal, without Claude Code. You
need Node.js 22 or newer and Git.

```sh
npx wbs-exercise list
npx wbs-exercise art-explorer
npx wbs-exercise art-explorer ./my-art-explorer
```

The command downloads the current exercises from the `stable` branch of
[WebDev-WBSCodingSchool/claude-code-plugin](https://github.com/WebDev-WBSCodingSchool/claude-code-plugin)
and runs the same setup script as the plugin's `/exercise:setup`. Then open
Claude Code in the new folder and run `/onboard`.

This package contains only the launcher. New or changed exercises reach students
through the plugin repository's release, not through a new version of this
package.

## Development

`npm test` runs the launcher against a local copy of the plugin repository,
by default `../wbs-cs`. Set `PLUGIN_CHECKOUT` to use another path.
