# agentsnippet

`agentsnippet` lets you reuse Markdown snippets in coding-agent instruction
files. Add includes to `AGENTS.template.md` or `CLAUDE.template.md`, then
generate a normal `AGENTS.md` or `CLAUDE.md`. No configuration file is needed.

## Quick start

Create a snippet in your project, such as `.agents/core.md`:

```md
## Working agreement

Run the tests before finishing a change.
```

Then create `AGENTS.template.md`:

```md
# Project instructions

<!-- @agentsnippet "./.agents/core.md" -->
```

Generate `AGENTS.md`:

```bash
npx agentsnippet
```

This writes `AGENTS.md` next to the template. Run the same command whenever the
template or one of its snippets changes.

For Claude Code, create `CLAUDE.template.md` instead:

```md
# Claude Code instructions

<!-- @agentsnippet "./.agents/core.md" -->
```

The same command writes `CLAUDE.md` next to that template. If a directory has
both template names, both outputs are generated in one run.

Node.js 20 or newer is required. Git is only needed when a template includes a
Git source.

## Include sources

### Local files

Relative paths are resolved from the file containing the include. For example,
if `AGENTS.template.md` is in the project root:

```md
<!-- @agentsnippet "./.agents/testing.md" -->
```

Absolute paths and paths beginning with `~/` are also supported:

```md
<!-- @agentsnippet "/path/to/shared/testing.md" -->
<!-- @agentsnippet "~/projects/shared/testing.md" -->
```

One convenient way to manage personal snippets is to store them in the magic
folder `~/.agents/agentsnippets`. Use the `@/` prefix to include a file from
that folder from any local template or nested local snippet:

```md
<!-- @agentsnippet "@/testing.md" -->
```

Here, `@/testing.md` means `~/.agents/agentsnippets/testing.md`. HTTP and Git
snippets cannot use `@/`, so remote content cannot cause local magic-folder
reads.

### HTTP URLs

You can include a Markdown file directly from an HTTP URL:

```md
<!-- @agentsnippet "https://example.com/snippets/testing.md" -->
```

The generated output may change when the remote file changes.

### Git repositories

Select a branch and a file from any Git repository:

```md
<!-- @agentsnippet "git+https://github.com/example/agent-snippets.git#main:snippets/testing.md" -->
```

The part after `#` has the form `<ref>:<path>`. The ref can be a branch, tag,
or commit. For example, you can select a versioned tag:

```md
<!-- @agentsnippet "git+https://github.com/example/agent-snippets.git#v1.0.0:snippets/testing.md" -->
```

Use a full commit hash when the generated output must stay fixed:

```md
<!-- @agentsnippet "git+https://github.com/example/agent-snippets.git#51d462976d84fdea54b47d80dcabbf680badcdb8:snippets/testing.md" -->
```

Private repositories use your existing Git and SSH authentication:

```md
<!-- @agentsnippet "git+ssh://git@github.com/company/agent-snippets.git#main:internal/security.md" -->
```

Snippets can include other snippets. If a snippet cannot be read from a local
file, HTTP URL, or Git URL, generation stops with a consistent snippet-read
error, a safe diagnostic category or allowlisted code, and the include trace. Cycles, malformed
directives, unsafe Git paths, and other resolution errors also stop generation.

## Choose a directory

By default, `agentsnippet` looks for `AGENTS.template.md` and
`CLAUDE.template.md` in the current directory. Pass another directory to work
there instead:

```bash
npx agentsnippet packages/sdk
```

Use `-r` to find templates in that directory and its descendants:

```bash
npx agentsnippet -r
npx agentsnippet -r packages
```

The `-r` option changes template discovery only. Included snippets are always
expanded recursively.

## Check generated files

Use `--check` to verify that every `AGENTS.md` and `CLAUDE.md` output matches
its template without writing any files:

```bash
npx agentsnippet --check
npx agentsnippet --check -r
```

For CI, pin the package version so the check uses the same release every time:

```yaml
- run: npx --yes agentsnippet@0.1.3 --check -r
```

## Agent skill

This repository also provides an optional agent skill for maintaining
agentsnippet templates and generated instructions. Install it globally for
Codex with:

```bash
npx skills add favoyang/agentsnippet --skill agentsnippet --global --agent codex --yes
```

The skill is installed from this GitHub repository. It is not included in the
agentsnippet npm package.

## Spec

See [SPEC.md](./SPEC.md) for the v1 behavior and limits.

## Security

Templates and snippets are trusted project instructions. `agentsnippet` does
not execute their Markdown content, but HTTP includes make network requests and
Git includes invoke the installed Git client. Use suitable filesystem and
network isolation when processing untrusted pull requests.

## License

MIT
