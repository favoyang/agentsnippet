---
name: agentsnippet
description: Manage reusable coding-agent instructions with the agentsnippet CLI. Use when creating, editing, sharing, generating, or validating AGENTS.md or CLAUDE.md instructions; when a repository contains AGENTS.template.md, CLAUDE.template.md, or @agentsnippet directives; or when generated instruction files may be stale or edited directly.
---

# Manage instructions with agentsnippet

Use `agentsnippet` to expand reusable Markdown into ordinary `AGENTS.md` and
`CLAUDE.md` files.

## Keep the source authoritative

- Treat `AGENTS.template.md` as the source for generated `AGENTS.md`.
- Treat `CLAUDE.template.md` as the source for generated `CLAUDE.md`.
- Edit a template or included snippet, not its generated output.
- Do not introduce a template when a single hand-written instruction file is
  sufficient. Use agentsnippet when reuse or drift checking adds value.

## Inspect before editing

Find templates, outputs, and existing includes:

```bash
rg --files -g 'AGENTS*.md' -g 'CLAUDE*.md'
rg -n '@agentsnippet' .
```

Read the relevant files and determine who should own the requested text.
Check generated outputs for direct or uncommitted edits. Move authorized
output-only content into the owning template or snippet before generation, and
preserve unrelated edits. Do not let generation overwrite unreconciled work.

## Choose the source

- Keep repository-specific instructions in the local template.
- Use a relative snippet for content shared within one repository.
- Use `@/name.md` for trusted snippets in the agentsnippet magic folder.
  The `@/` prefix points to `~/.agents/agentsnippets/`, so `@/testing.md`
  resolves to `~/.agents/agentsnippets/testing.md`.
- Use a Git source for content shared across machines or repositories. Prefer
  a tag or full commit ID; use a full commit ID when output must be fixed.
- Use an HTTP source only when mutable remote content is intentional.

Do not move project-specific rules into a shared snippet without preserving
local exceptions and context.

## Add includes

Place each directive on its own line:

```md
<!-- @agentsnippet "<source>" -->
```

Examples:

```md
<!-- @agentsnippet "./.agents/testing.md" -->
<!-- @agentsnippet "@/pull-request-delivery-workflow.md" -->
<!-- @agentsnippet "git+https://github.com/example/instructions.git#v1.0.0:snippets/testing.md" -->
```

Snippets may include other snippets. Keep headings and transitions usable in
every intended parent document.

Directives inside blockquotes, code spans, fenced code blocks, or indented
code blocks are examples and are not expanded.

## Generate and check

Use the repository's documented or pinned invocation when available.
Otherwise, use the installed CLI or its normal `npx` entry point.

```bash
agentsnippet
agentsnippet --check
```

For nested projects or a monorepo:

```bash
agentsnippet -r
agentsnippet --check -r
```

After editing:

1. Generate the output.
2. Inspect the generated diff for duplicated headings, broken transitions,
   or unintended content.
3. Run `--check` to confirm every output is current.
4. Report the source and generated files that changed.

Do not copy expanded content by hand to work around a generation failure.

## Add CI checks

When asked to enforce freshness in CI, pin the package version:

```yaml
- run: npx --yes agentsnippet@<version> --check -r
```

Match the repository's package manager and dependency policy. Do not add CI or
dependencies when the request is limited to local authoring.

## Diagnose failures

- Exit `0`: generation or checking succeeded.
- Exit `1`: output is stale, or source resolution or generation failed.
- Exit `2`: command-line usage is invalid.

For include failures, follow the include trace and check the directive, source
path, magic-folder link, Git ref or authentication, cycles, and nesting.
Fix the source instead of patching generated output.

## Keep trust boundaries

Treat templates and snippets as trusted agent instructions. Inspect ownership
and content before adding a remote source. Avoid secrets, credentials, personal
paths, and private assumptions in portable snippets.

Remember:

- HTTP content can change without a repository commit.
- Git and HTTP sources may require network access.
- Git sources use the user's existing Git authentication.
- Remote sources cannot include files from the local `@/` magic folder.
- agentsnippet expands Markdown but does not execute it.

Do not publish a shared snippet or roll it out to other repositories without
user authorization.
