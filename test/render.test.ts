import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { renderTemplate } from "../src/render.js";
import { SourceResolver, resolveLocalPath } from "../src/sources.js";
import { temporaryDirectory } from "./helpers.js";

const execFileAsync = promisify(execFile);

describe("local rendering", () => {
  it("identifies root-template read failures", async (context) => {
    const directory = await temporaryDirectory(context);
    await assert.rejects(
      renderTemplate(join(directory, "missing.template.md")),
      /Could not read root template .*Local source does not exist/,
    );
  });

  it("resolves paths beginning with ~/ from the home directory", () => {
    const homeDirectory = resolve("home", "example");
    const parentFilePath = resolve("project", "AGENTS.template.md");
    assert.equal(
      resolveLocalPath("~/shared/testing.md", parentFilePath, homeDirectory),
      join(homeDirectory, "shared", "testing.md"),
    );
    assert.equal(
      resolveLocalPath("~", parentFilePath, homeDirectory),
      resolve(dirname(parentFilePath), "~"),
    );
    assert.equal(
      resolveLocalPath("~//shared/testing.md", parentFilePath, homeDirectory),
      join(homeDirectory, "shared", "testing.md"),
    );
  });

  it("resolves @/ from the agentsnippets magic folder", async (context) => {
    const directory = await temporaryDirectory(context);
    const homeDirectory = join(directory, "home");
    const magicDirectory = join(homeDirectory, ".agents", "agentsnippets");
    await mkdir(magicDirectory, { recursive: true });
    await writeFile(join(magicDirectory, "testing.md"), "## Testing\n\nRun tests.\n");
    await writeFile(join(magicDirectory, "..shared.md"), "Contained dot file.\n");
    await writeFile(
      join(directory, "AGENTS.template.md"),
      '<!-- @agentsnippet "@/testing.md" -->\n',
    );

    assert.equal(
      resolveLocalPath("@/testing.md", join(directory, "AGENTS.template.md"), homeDirectory),
      join(magicDirectory, "testing.md"),
    );
    const resolver = new SourceResolver({ homeDirectory });
    const output = await renderTemplate(join(directory, "AGENTS.template.md"), resolver);
    assert.equal(output.content, "## Testing\n\nRun tests.\n");
    assert.equal(
      (await resolver.resolve("@/..shared.md", {
        kind: "local",
        filePath: join(directory, "AGENTS.template.md"),
      })).content,
      "Contained dot file.\n",
    );
  });

  it("rejects magic-folder traversal and remote-parent access", async (context) => {
    const directory = await temporaryDirectory(context);
    const homeDirectory = join(directory, "home");
    const resolver = new SourceResolver({ homeDirectory });
    await assert.rejects(
      resolver.resolve("@/../secret.md", {
        kind: "local",
        filePath: join(directory, "AGENTS.template.md"),
      }),
      /Magic-folder source escapes/,
    );
    const remoteParents = [
      { kind: "http" as const, url: "https://example.test/root.md" },
      {
        kind: "git" as const,
        repositoryUrl: "https://example.test/agents.git",
        repositoryDisplay: "https://example.test/agents.git",
        repositoryCachePath: join(directory, "cache"),
        commit: "a".repeat(40),
        filePath: "root.md",
      },
    ];

    for (const parent of remoteParents) {
      await assert.rejects(
        resolver.resolve("@/testing.md", parent),
        /only be included from local sources/,
      );
    }
  });

  it("rejects magic-folder symlinks that escape the folder", async (context) => {
    if (process.platform === "win32") context.skip("symlink creation requires additional privileges");
    const directory = await temporaryDirectory(context);
    const homeDirectory = join(directory, "home");
    const magicDirectory = join(homeDirectory, ".agents", "agentsnippets");
    await mkdir(magicDirectory, { recursive: true });
    await writeFile(join(directory, "secret.md"), "private\n");
    const { symlink } = await import("node:fs/promises");
    await symlink(join(directory, "secret.md"), join(magicDirectory, "escape.md"));
    const resolver = new SourceResolver({ homeDirectory });

    await assert.rejects(
      resolver.resolve("@/escape.md", { kind: "local", filePath: join(directory, "AGENTS.template.md") }),
      /Magic-folder source escapes/,
    );
  });

  it("reads a magic-folder symlink whose canonical target stays inside", async (context) => {
    if (process.platform === "win32") context.skip("symlink creation requires additional privileges");
    const directory = await temporaryDirectory(context);
    const homeDirectory = join(directory, "home");
    const magicDirectory = join(homeDirectory, ".agents", "agentsnippets");
    await mkdir(magicDirectory, { recursive: true });
    await writeFile(join(magicDirectory, "target.md"), "safe target\n");
    const { symlink } = await import("node:fs/promises");
    await symlink(join(magicDirectory, "target.md"), join(magicDirectory, "link.md"));
    const resolver = new SourceResolver({ homeDirectory });

    assert.equal(
      (await resolver.resolve("@/link.md", {
        kind: "local",
        filePath: join(directory, "AGENTS.template.md"),
      })).content,
      "safe target\n",
    );
  });

  it("rejects a FIFO without waiting for a writer", async (context) => {
    if (process.platform === "win32") context.skip("FIFOs are POSIX-specific");
    const directory = await temporaryDirectory(context);
    const homeDirectory = join(directory, "home");
    const magicDirectory = join(homeDirectory, ".agents", "agentsnippets");
    await mkdir(magicDirectory, { recursive: true });
    await execFileAsync("mkfifo", [join(magicDirectory, "pipe.md")]);
    const resolver = new SourceResolver({ homeDirectory });

    await assert.rejects(
      resolver.resolve("@/pipe.md", {
        kind: "local",
        filePath: join(directory, "AGENTS.template.md"),
      }),
      /not a regular file/,
    );
  });

  it("expands nested local snippets and normalizes line endings", async (context) => {
    const directory = await temporaryDirectory(context);
    await mkdir(join(directory, "snippets"));
    await writeFile(
      join(directory, "AGENTS.template.md"),
      '# Project\r\n\r\n<!-- @agentsnippet "./snippets/core.md" -->\r\n',
    );
    await writeFile(
      join(directory, "snippets", "core.md"),
      '## Core\n\n<!-- @agentsnippet "./testing.md" -->\n',
    );
    await writeFile(join(directory, "snippets", "testing.md"), "## Testing\n\nRun tests.\n\n\n");

    const output = await renderTemplate(join(directory, "AGENTS.template.md"));
    assert.equal(output.content, "# Project\n\n## Core\n\n## Testing\n\nRun tests.\n");
    assert.equal(output.outputPath, join(directory, "AGENTS.md"));
  });

  it("preserves malformed directive diagnostics from nested snippets", async (context) => {
    const directory = await temporaryDirectory(context);
    await writeFile(join(directory, "AGENTS.template.md"), '<!-- @agentsnippet "./part.md" -->\n');
    await writeFile(join(directory, "part.md"), "<!-- @agentsnippet ./missing.md -->\n");

    await assert.rejects(renderTemplate(join(directory, "AGENTS.template.md")), (error: unknown) => {
      assert.match(String(error), /Malformed agentsnippet directive .*part\.md:1/);
      assert.match(String(error), /Include chain:/);
      assert.doesNotMatch(String(error), /Backend source read failed/);
      return true;
    });
  });

  it("reports cycles with the full include chain", async (context) => {
    const directory = await temporaryDirectory(context);
    await writeFile(join(directory, "AGENTS.template.md"), '<!-- @agentsnippet "./a.md" -->\n');
    await writeFile(join(directory, "a.md"), '<!-- @agentsnippet "./b.md" -->\n');
    await writeFile(join(directory, "b.md"), '<!-- @agentsnippet "./a.md" -->\n');

    await assert.rejects(
      renderTemplate(join(directory, "AGENTS.template.md")),
      (error: unknown) => {
        assert.match(String(error), /Include cycle detected/);
        assert.match(String(error), /a\.md/);
        assert.match(String(error), /b\.md/);
        return true;
      },
    );
  });

  it("does not misreport other local filesystem failures as missing", async (context) => {
    const directory = await temporaryDirectory(context);
    const oversizedName = "x".repeat(300);
    await writeFile(
      join(directory, "AGENTS.template.md"),
      `<!-- @agentsnippet "./${oversizedName}" -->\n`,
    );

    await assert.rejects(renderTemplate(join(directory, "AGENTS.template.md")), (error: unknown) => {
      assert.match(String(error), /Could not inspect local source/);
      assert.doesNotMatch(String(error), /does not exist/);
      return true;
    });
  });

  it("leaves directive examples in code blocks untouched", async (context) => {
    const directory = await temporaryDirectory(context);
    const template = ['```md', '<!-- @agentsnippet "./missing.md" -->', "```", ""].join("\n");
    await writeFile(join(directory, "AGENTS.template.md"), template);
    const output = await renderTemplate(join(directory, "AGENTS.template.md"));
    assert.equal(output.content, template);
  });

  it("allows repeated non-recursive includes", async (context) => {
    const directory = await temporaryDirectory(context);
    await writeFile(
      join(directory, "AGENTS.template.md"),
      '<!-- @agentsnippet "./part.md" -->\n<!-- @agentsnippet "./part.md" -->\n',
    );
    await writeFile(join(directory, "part.md"), "Part\n");
    const output = await renderTemplate(join(directory, "AGENTS.template.md"));
    assert.equal(output.content, "Part\nPart\n");
  });

  it("treats unsupported git+ prefixes as relative filenames", async (context) => {
    const directory = await temporaryDirectory(context);
    await writeFile(
      join(directory, "AGENTS.template.md"),
      '<!-- @agentsnippet "./git+notes.md" -->\n',
    );
    await writeFile(join(directory, "git+notes.md"), "Local notes.\n");
    const output = await renderTemplate(join(directory, "AGENTS.template.md"));
    assert.equal(output.content, "Local notes.\n");
  });

  it("reports missing unsupported git+ prefixes as local filenames", async (context) => {
    const directory = await temporaryDirectory(context);
    await writeFile(
      join(directory, "AGENTS.template.md"),
      '<!-- @agentsnippet "git+missing.md" -->\n',
    );

    await assert.rejects(renderTemplate(join(directory, "AGENTS.template.md")), (error: unknown) => {
      assert.match(String(error), /Could not read snippet "git\+missing\.md"/);
      assert.doesNotMatch(String(error), /<redacted-source>/);
      return true;
    });
  });

  it("preserves trailing blank lines inside an included snippet", async (context) => {
    const directory = await temporaryDirectory(context);
    await writeFile(
      join(directory, "AGENTS.template.md"),
      'Before\n<!-- @agentsnippet "./part.md" -->\nAfter\n',
    );
    await writeFile(join(directory, "part.md"), "Included\n\n");
    const output = await renderTemplate(join(directory, "AGENTS.template.md"));
    assert.equal(output.content, "Before\nIncluded\n\nAfter\n");
  });

  it("preserves the directive line ending after a snippet without a final newline", async (context) => {
    const directory = await temporaryDirectory(context);
    await writeFile(
      join(directory, "AGENTS.template.md"),
      'Before\n<!-- @agentsnippet "./part.md" -->\nAfter\n',
    );
    await writeFile(join(directory, "part.md"), "Included");
    const output = await renderTemplate(join(directory, "AGENTS.template.md"));
    assert.equal(output.content, "Before\nIncluded\nAfter\n");
  });

  it("bounds recursive include depth", async (context) => {
    const directory = await temporaryDirectory(context);
    await writeFile(join(directory, "AGENTS.template.md"), '<!-- @agentsnippet "./part-0.md" -->\n');
    for (let index = 0; index < 33; index += 1) {
      const next = index === 32 ? "end\n" : `<!-- @agentsnippet "./part-${index + 1}.md" -->\n`;
      await writeFile(join(directory, `part-${index}.md`), next);
    }
    await assert.rejects(
      renderTemplate(join(directory, "AGENTS.template.md")),
      /Include depth exceeds the limit of 32/,
    );
  });
});
