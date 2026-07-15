# agentsnippet

`agentsnippet` lets you reuse Markdown snippets in `AGENTS.md`. Add includes to
`AGENTS.template.md`, then generate a normal `AGENTS.md` that works with any
coding agent. No configuration file is needed.

## Quick start

Create a snippet at `.agents/core.md`:

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

Node.js 20 or newer is required. Git is only needed when a template includes a
Git source.

## Include sources

### Local files

Relative paths are resolved from the file that contains the include:

```md
<!-- @agentsnippet "../shared/testing.md" -->
```

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
or commit. Use a full commit hash when the generated output must stay fixed:

```md
<!-- @agentsnippet "git+https://github.com/example/agent-snippets.git#51d462976d84fdea54b47d80dcabbf680badcdb8:snippets/testing.md" -->
```

Private repositories use your existing Git and SSH authentication:

```md
<!-- @agentsnippet "git+ssh://git@github.com/company/agent-snippets.git#main:internal/security.md" -->
```

Snippets can include other snippets. Missing sources, include cycles, malformed
directives, unsafe Git paths, and network failures stop generation and show the
include trace.

## Choose a directory

By default, `agentsnippet` only looks for `AGENTS.template.md` in the current
directory. Pass another directory to work there instead:

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

Use `--check` to verify that every output matches its template without writing
any files:

```bash
npx agentsnippet --check
npx agentsnippet --check -r
```

For CI, pin the package version so the check uses the same release every time:

```yaml
- run: npx --yes agentsnippet@0.1.1 --check -r
```

## Command reference

```text
npx agentsnippet [options] [directory]

-r, --recursive   Process nested AGENTS.template.md files
    --check       Verify outputs without writing
-h, --help        Show help
-v, --version     Show version
```

See [SPEC.md](./SPEC.md) for the exact v1 behavior and limits.

## Security

Templates and snippets are trusted project instructions. `agentsnippet` does
not execute their Markdown content, but HTTP includes make network requests and
Git includes invoke the installed Git client. Use suitable filesystem and
network isolation when processing untrusted pull requests.

## License

MIT
