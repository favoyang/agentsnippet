import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { renderTemplate } from "../src/render.js";
import { temporaryDirectory } from "./helpers.js";

describe("local rendering", () => {
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
