# agentsnippet v1 specification

## Files

`agentsnippet` reads `AGENTS.template.md` and writes `AGENTS.md` beside it. The
template is authoritative. Generated output contains expanded Markdown only.

Without `-r`, exactly one template is selected in the requested directory. With
`-r`, the starting directory and its descendants are searched. Git ignore rules
are honored when available, `.git` is always skipped, and directory symlinks are
not followed.

## Directive

An include directive is an HTML comment on a complete Markdown line:

```md
<!-- @agentsnippet "<source>" -->
```

Horizontal whitespace around the comment and within the comment boundary is
allowed. The source is non-empty and cannot contain a quote or newline.
Directives are recognized as CommonMark HTML nodes, so examples in code spans,
fenced code, and indented code are not expanded. An HTML comment containing
`@agentsnippet` that does not match the grammar is an error.

The directive line is replaced by the recursively expanded source. Cycles and
include nesting beyond 32 active sources are errors. All text is decoded as
UTF-8, line endings are normalized to LF, and each generated file ends with
exactly one LF.

## Sources

Sources beginning with `http://` or `https://` are direct HTTP resources.
Relative sources nested within HTTP content use standard URL resolution.
Requests have a 15-second timeout, at most five redirects, and a 1 MiB body
limit. Non-success HTTP status codes are errors.

Sources beginning with `git+https://` or `git+ssh://` use this grammar:

```text
git+<transport-url>#<ref>:<path-within-repository>
```

The ref and repository-relative path are required. The first colon after `#`
separates them. The leading `git+` is removed before invoking Git. The selected
path must be a regular blob, must not be a symlink, and cannot escape the
repository. Full 40- or 64-character commit IDs are reused from the local cache;
other refs are fetched on each process run. Git authentication is inherited from
the user's normal Git configuration.

Every other source is a local filesystem path. Paths beginning with `@/` are
resolved from the magic folder `~/.agents/agentsnippets` when the containing
source is local; HTTP and Git sources cannot use the magic folder. Paths
beginning with `~/` are resolved from the user's home directory. Other relative
paths are resolved from the file containing the directive. Absolute and nested
local paths use normal filesystem semantics. Local, HTTP, and Git resolution
failures are reported uniformly as snippet-read errors with safe diagnostic
categories or allowlisted codes and an include trace; raw backend messages
remain only in internal error causes.

## CLI

```text
agentsnippet [options] [directory]

-r, --recursive   discover nested templates
    --check       compare generated content without writing
-h, --help        print help
-v, --version     print the package version
```

The directory defaults to `.`. More than one directory, unknown options, a
missing directory, or no selected template is an error. `--check` exits nonzero
and reports every missing or stale output without writing. Normal mode renders
all selected templates before staging changes and rolls back output changes if
the multi-file commit fails.

## Exit status

- `0`: generation succeeded, outputs are current, or help/version was shown.
- `1`: resolution, rendering, filesystem, network, Git, or stale-output error.
- `2`: invalid command-line usage.
