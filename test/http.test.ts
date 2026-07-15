import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { once } from "node:events";
import { renderTemplate } from "../src/render.js";
import { MAX_SOURCE_BYTES } from "../src/types.js";
import { temporaryDirectory } from "./helpers.js";

describe("HTTP sources", () => {
  it("follows redirects and resolves nested relative URLs", async (context) => {
    const server = createServer((request, response) => {
      if (request.url === "/redirect") {
        response.writeHead(302, { Location: "/remote/root.md" }).end();
      } else if (request.url === "/remote/root.md") {
        response.end('# Remote\n\n<!-- @agentsnippet "./nested.md" -->\n');
      } else if (request.url === "/remote/nested.md") {
        response.end("## Nested\n\nHTTP works.\n");
      } else {
        response.writeHead(404).end();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    context.after(() => server.close());
    const address = server.address();
    assert(address && typeof address !== "string");

    const directory = await temporaryDirectory(context);
    await writeFile(
      join(directory, "AGENTS.template.md"),
      `<!-- @agentsnippet "http://127.0.0.1:${address.port}/redirect" -->\n`,
    );
    const output = await renderTemplate(join(directory, "AGENTS.template.md"));
    assert.equal(output.content, "# Remote\n\n## Nested\n\nHTTP works.\n");
  });

  it("rejects oversized responses before reading them", async (context) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Length": String(MAX_SOURCE_BYTES + 1) }).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    context.after(() => server.close());
    const address = server.address();
    assert(address && typeof address !== "string");

    const directory = await temporaryDirectory(context);
    await writeFile(
      join(directory, "AGENTS.template.md"),
      `<!-- @agentsnippet "http://127.0.0.1:${address.port}/large.md" -->\n`,
    );
    await assert.rejects(renderTemplate(join(directory, "AGENTS.template.md")), /exceeds.*byte limit/);
  });

  it("redacts HTTP query credentials from errors", async (context) => {
    const server = createServer((_request, response) => response.writeHead(500).end());
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    context.after(() => server.close());
    const address = server.address();
    assert(address && typeof address !== "string");

    const directory = await temporaryDirectory(context);
    await writeFile(
      join(directory, "AGENTS.template.md"),
      `<!-- @agentsnippet "http://127.0.0.1:${address.port}/fail.md?token=secret-value" -->\n`,
    );
    await assert.rejects(renderTemplate(join(directory, "AGENTS.template.md")), (error: unknown) => {
      assert.doesNotMatch(String(error), /secret-value/);
      assert.match(String(error), /HTTP 500/);
      return true;
    });
  });

  it("redacts query credentials from relative HTTP includes", async (context) => {
    const server = createServer((request, response) => {
      if (request.url === "/root.md") {
        response.end('<!-- @agentsnippet "./child.md?token=relative-secret" -->\n');
      } else {
        response.writeHead(500).end();
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    context.after(() => server.close());
    const address = server.address();
    assert(address && typeof address !== "string");

    const directory = await temporaryDirectory(context);
    await writeFile(
      join(directory, "AGENTS.template.md"),
      `<!-- @agentsnippet "http://127.0.0.1:${address.port}/root.md" -->\n`,
    );
    await assert.rejects(renderTemplate(join(directory, "AGENTS.template.md")), (error: unknown) => {
      assert.doesNotMatch(String(error), /relative-secret/);
      assert.match(String(error), /HTTP 500/);
      return true;
    });
  });
});
