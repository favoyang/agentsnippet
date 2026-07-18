import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseGitSource, sanitizeGitError } from "../src/git-source.js";
import { renderTemplate } from "../src/render.js";
import { SourceResolver } from "../src/sources.js";
import { git, temporaryDirectory } from "./helpers.js";

describe("Git sources", () => {
  it("parses HTTPS and SSH transports without ambiguity", () => {
    assert.deepEqual(
      parseGitSource("git+https://example.com/agents.git#v1.2.0:snippets/git.md"),
      {
        repositoryUrl: "https://example.com/agents.git",
        repositoryDisplay: "https://example.com/agents.git",
        ref: "v1.2.0",
        filePath: "snippets/git.md",
      },
    );
    assert.equal(
      parseGitSource("git+ssh://git@example.com/team/agents.git#main:path:with-colon.md").filePath,
      "path:with-colon.md",
    );
    assert.doesNotMatch(
      parseGitSource("git+https://token:secret@example.com/agents.git#main:snippet.md")
        .repositoryDisplay,
      /token|secret/,
    );
    assert.throws(() => parseGitSource("git+http://example.com/agents.git#main:snippet.md"), /Unsupported Git source/);
    assert.throws(
      () => parseGitSource("git+https://[invalid#main:snippet.md"),
      (error: unknown) => {
        assert(error instanceof Error && error.cause instanceof TypeError);
        return true;
      },
    );
    assert.throws(
      () => parseGitSource("git+https://example.com/agents.git#main:../secret.md"),
      /escapes the repository/,
    );
  });

  it("redacts credentials from normalized Git error URLs", () => {
    const repositoryUrl = "https://user:password@example.com/agents.git?token=query-secret";
    const message =
      "fatal: unable to access 'https://example.com/agents.git?token=query-secret/': authentication failed for user";
    const sanitized = sanitizeGitError(message, repositoryUrl);
    assert.doesNotMatch(sanitized, /user|password|query-secret/);
    assert.match(sanitized, /Git command failed/);
  });

  it("preserves non-absence Git cache inspection failures as causes", async (context) => {
    if (process.platform === "win32") context.skip("symlink creation requires additional privileges");
    const directory = await temporaryDirectory(context);
    const cacheDirectory = join(directory, "cache");
    const repositoryUrl = "https://example.invalid/agents.git";
    const cacheRepository = join(
      cacheDirectory,
      "git",
      createHash("sha256").update(repositoryUrl).digest("hex"),
    );
    await mkdir(cacheRepository, { recursive: true });
    await symlink("HEAD", join(cacheRepository, "HEAD"));
    const resolver = new SourceResolver({ cacheDirectory });

    await assert.rejects(
      resolver.resolve(`git+${repositoryUrl}#main:snippet.md`, {
        kind: "local",
        filePath: join(directory, "AGENTS.template.md"),
      }),
      (error: unknown) => {
        assert.match(String(error), /Could not inspect the agentsnippet Git cache/);
        assert(error instanceof Error && error.cause instanceof Error);
        assert.equal((error.cause.cause as NodeJS.ErrnoException).code, "ELOOP");
        return true;
      },
    );
  });

  it("reads a pinned Git blob from cache and expands nested repository files", async (context) => {
    const directory = await temporaryDirectory(context);
    const cacheDirectory = join(directory, "cache");
    const working = join(directory, "working");
    const repositoryUrl = "https://example.invalid/agents.git";
    const cacheRepository = join(
      cacheDirectory,
      "git",
      createHash("sha256").update(repositoryUrl).digest("hex"),
    );
    await mkdir(working, { recursive: true });
    await mkdir(cacheRepository, { recursive: true });
    await git(working, "init", "--quiet");
    await git(cacheRepository, "init", "--bare", "--quiet");
    await mkdir(join(working, "snippets"));
    await writeFile(
      join(working, "snippets", "root.md"),
      '# Git source\n\n<!-- @agentsnippet "./nested.md" -->\n',
    );
    await writeFile(join(working, "snippets", "nested.md"), "## Nested\n\nPinned content.\n");
    await git(working, "add", ".");
    await git(working, "commit", "--quiet", "-m", "fixture");
    await writeFile(join(working, "link-target"), "nested.md");
    const linkBlob = await git(working, "hash-object", "-w", "link-target");
    await git(working, "update-index", "--add", "--cacheinfo", `120000,${linkBlob},snippets/link.md`);
    await git(working, "commit", "--quiet", "-m", "symlink fixture");
    const commit = await git(working, "rev-parse", "HEAD");
    await git(working, "push", "--quiet", cacheRepository, "HEAD:refs/heads/main");

    await writeFile(
      join(directory, "AGENTS.template.md"),
      `<!-- @agentsnippet "git+${repositoryUrl}#${commit}:snippets/root.md" -->\n`,
    );
    const resolver = new SourceResolver({ cacheDirectory });
    const output = await renderTemplate(join(directory, "AGENTS.template.md"), resolver);
    assert.equal(output.content, "# Git source\n\n## Nested\n\nPinned content.\n");

    await writeFile(
      join(directory, "AGENTS.template.md"),
      `<!-- @agentsnippet "git+${repositoryUrl}#${commit}:snippets/missing.md" -->\n`,
    );
    await assert.rejects(
      renderTemplate(join(directory, "AGENTS.template.md"), resolver),
      /Could not read snippet .*Git source does not contain/,
    );

    await assert.rejects(
      resolver.git.resolve(`git+${repositoryUrl}#${commit}:snippets/link.md`),
      /symlink and cannot be included/,
    );
  });

  it("initializes caches with the object format used by a SHA-256 remote", async (context) => {
    const directory = await temporaryDirectory(context);
    const working = join(directory, "working");
    const remote = join(directory, "remote.git");
    const repositoryUrl = "https://sha256.example.invalid/agents.git";
    await mkdir(working);
    await mkdir(remote);
    await git(working, "init", "--quiet", "--object-format=sha256");
    await git(remote, "init", "--bare", "--quiet", "--object-format=sha256");
    await writeFile(join(working, "snippet.md"), "SHA-256 content.\n");
    await git(working, "add", ".");
    await git(working, "commit", "--quiet", "-m", "fixture");
    await git(working, "push", "--quiet", remote, "HEAD:refs/heads/main");

    const previous = new Map<string, string | undefined>();
    const config = {
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: `url.file://${remote}.insteadOf`,
      GIT_CONFIG_VALUE_0: repositoryUrl,
      GIT_CONFIG_KEY_1: "protocol.file.allow",
      GIT_CONFIG_VALUE_1: "always",
    };
    for (const [key, value] of Object.entries(config)) {
      previous.set(key, process.env[key]);
      process.env[key] = value;
    }

    try {
      const resolver = new SourceResolver({ cacheDirectory: join(directory, "cache") });
      await assert.rejects(
        resolver.git.resolve(`git+${repositoryUrl}#${"0".repeat(40)}:snippet.md`),
        /Could not fetch/,
      );
      const source = await resolver.git.resolve(`git+${repositoryUrl}#main:snippet.md`);
      assert.equal(source.content, "SHA-256 content.\n");
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
