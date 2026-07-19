import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findIncludeDirectives } from "../src/directives.js";

describe("directive parsing", () => {
  it("recognizes a standalone namespaced HTML comment", () => {
    const markdown = '# Title\n\n  <!--   @agentsnippet   "./part.md"   -->  \n';
    assert.deepEqual(findIncludeDirectives(markdown, "template.md"), [
      {
        source: "./part.md",
        start: 9,
        end: markdown.length,
        line: 3,
      },
    ]);
  });

  it("ignores examples in fenced, indented, and inline code", () => {
    const markdown = [
      "```md",
      '<!-- @agentsnippet "./fenced.md" -->',
      "```",
      "",
      '    <!-- @agentsnippet "./indented.md" -->',
      "",
      '`<!-- @agentsnippet "./inline.md" -->`',
      "",
    ].join("\n");
    assert.deepEqual(findIncludeDirectives(markdown, "template.md"), []);
  });

  it("ignores directives in blockquotes", () => {
    const markdown = [
      "> Some quoted documentation:",
      '> <!-- @agentsnippet "./quoted.md" -->',
      "> <!-- @agentsnippet ./malformed.md -->",
      "",
    ].join("\n");
    assert.deepEqual(findIncludeDirectives(markdown, "template.md"), []);
  });

  it("rejects malformed directive comments", () => {
    assert.throws(
      () => findIncludeDirectives("<!-- @agentsnippet ./part.md -->\n", "template.md"),
      /Malformed agentsnippet directive.*template\.md:1/,
    );
    assert.throws(
      () => findIncludeDirectives('Prefix <!-- @agentsnippet "part.md" -->\n', "template.md"),
      /on its own line/,
    );
  });

  it("ignores the directive name in ordinary raw HTML", () => {
    const markdown = '<div data-tool="@agentsnippet">Keep this HTML.</div>\n';
    assert.deepEqual(findIncludeDirectives(markdown, "template.md"), []);
  });

  it("recognizes directive comments inside raw HTML blocks", () => {
    const markdown = '<div>\n<!-- @agentsnippet "./part.md" -->\n</div>\n';
    assert.deepEqual(findIncludeDirectives(markdown, "template.md"), [
      {
        source: "./part.md",
        start: markdown.indexOf("<!--"),
        end: markdown.indexOf("</div>"),
        line: 2,
      },
    ]);
  });
});
