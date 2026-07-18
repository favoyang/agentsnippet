import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { once } from "node:events";
import { renderTemplate } from "../src/render.js";
import { AgentSnippetError } from "../src/errors.js";
import { SourceResolver } from "../src/sources.js";
import { MAX_SOURCE_BYTES } from "../src/types.js";
import { temporaryDirectory } from "./helpers.js";

describe("HTTP sources", () => {
  it("retains malformed URL parser errors as internal causes", async (context) => {
    const directory = await temporaryDirectory(context);
    const resolver = new SourceResolver();
    await assert.rejects(
      resolver.resolve("https://[invalid", {
        kind: "local",
        filePath: join(directory, "AGENTS.template.md"),
      }),
      (error: unknown) => {
        assert(error instanceof Error && error.cause instanceof Error);
        assert(error.cause.cause instanceof TypeError);
        return true;
      },
    );
  });

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

  it("keeps the body-limit failure primary when cancellation fails", async (context) => {
    const cancelSecret = "RAW_CANCEL_SECRET";
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_SOURCE_BYTES + 1));
      },
      cancel() {
        throw new Error(cancelSecret);
      },
    });
    const fetchImplementation = async () => new Response(stream, { status: 200 });
    const directory = await temporaryDirectory(context);
    await writeFile(
      join(directory, "AGENTS.template.md"),
      '<!-- @agentsnippet "https://example.test/large.md" -->\n',
    );
    const resolver = new SourceResolver({ fetchImplementation: fetchImplementation as typeof fetch });

    await assert.rejects(renderTemplate(join(directory, "AGENTS.template.md"), resolver), (error: unknown) => {
      assert.match(String(error), /exceeds.*byte limit/);
      assert.doesNotMatch(String(error), new RegExp(cancelSecret));
      assert(error instanceof Error && error.cause instanceof Error);
      return true;
    });
  });

  it("identifies a 404 response as a snippet read failure", async (context) => {
    const url = "https://example.test/missing.md";
    const directory = await temporaryDirectory(context);
    await writeFile(join(directory, "AGENTS.template.md"), `<!-- @agentsnippet "${url}" -->\n`);
    const resolver = new SourceResolver({
      fetchImplementation: (async () => new Response("", { status: 404 })) as typeof fetch,
    });
    await assert.rejects(renderTemplate(join(directory, "AGENTS.template.md"), resolver), (error: unknown) => {
      assert.match(String(error), /Could not read snippet/);
      assert.match(String(error), /HTTP 404/);
      return true;
    });
  });

  it("preserves sanitized HTTP transport failure details", async (context) => {
    const secret = "query-secret";
    const unrelatedSecret = "proxy-bearer-secret";
    const source = `https://example.test/snippet.md?token=${secret}`;
    const cause = Object.assign(new Error(`connect ECONNREFUSED ${secret} ${unrelatedSecret}`), {
      code: "ECONNREFUSED",
    });
    const fetchImplementation = async () => {
      throw Object.assign(new Error(`Proxy-Authorization: Bearer ${unrelatedSecret}`, { cause }), {
        code: "PROXY_BEARER_SECRET",
      });
    };
    const directory = await temporaryDirectory(context);
    await writeFile(join(directory, "AGENTS.template.md"), `<!-- @agentsnippet "${source}" -->\n`);
    const resolver = new SourceResolver({ fetchImplementation: fetchImplementation as typeof fetch });

    await assert.rejects(renderTemplate(join(directory, "AGENTS.template.md"), resolver), (error: unknown) => {
      assert.match(String(error), /ECONNREFUSED/);
      assert.doesNotMatch(String(error), new RegExp(secret));
      assert.doesNotMatch(String(error), new RegExp(unrelatedSecret));
      assert.doesNotMatch(String(error), /PROXY_BEARER_SECRET/);
      return true;
    });
  });

  it("retains the original transport error when code inspection fails", async (context) => {
    const transportError = new Error("hidden transport detail");
    Object.defineProperty(transportError, "code", {
      get() {
        throw new Error("code accessor failed");
      },
    });
    const fetchImplementation = async () => {
      throw transportError;
    };
    const directory = await temporaryDirectory(context);
    await writeFile(
      join(directory, "AGENTS.template.md"),
      '<!-- @agentsnippet "https://example.test/snippet.md" -->\n',
    );
    const resolver = new SourceResolver({ fetchImplementation: fetchImplementation as typeof fetch });

    await assert.rejects(renderTemplate(join(directory, "AGENTS.template.md"), resolver), (error: unknown) => {
      assert(error instanceof Error);
      const causes: unknown[] = [];
      let current: unknown = error;
      while (current instanceof Error && current.cause !== undefined) {
        current = current.cause;
        causes.push(current);
      }
      assert(causes.includes(transportError));
      assert.doesNotMatch(String(error), /hidden transport detail|code accessor failed/);
      return true;
    });
  });

  it("does not expose raw HTTP body-stream failures", async (context) => {
    const secret = "RAW_BACKEND_SECRET";
    const fetchImplementation = async () =>
      new Response(
        new ReadableStream({
          pull() {
            throw new AgentSnippetError(secret);
          },
        }),
        { status: 200 },
      );
    const directory = await temporaryDirectory(context);
    await writeFile(
      join(directory, "AGENTS.template.md"),
      '<!-- @agentsnippet "https://example.test/snippet.md" -->\n',
    );
    const resolver = new SourceResolver({ fetchImplementation: fetchImplementation as typeof fetch });

    await assert.rejects(renderTemplate(join(directory, "AGENTS.template.md"), resolver), (error: unknown) => {
      assert.match(String(error), /Backend source read failed/);
      assert.doesNotMatch(String(error), new RegExp(secret));
      return true;
    });
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

  it("rejects magic-folder references from nested HTTP sources", async (context) => {
    const directory = await temporaryDirectory(context);
    const url = "https://example.test/root.md";
    await writeFile(join(directory, "AGENTS.template.md"), `<!-- @agentsnippet "${url}" -->\n`);
    const resolver = new SourceResolver({
      homeDirectory: join(directory, "home"),
      fetchImplementation: (async () =>
        new Response('<!-- @agentsnippet "@/missing.md" -->\n')) as typeof fetch,
    });
    await assert.rejects(renderTemplate(join(directory, "AGENTS.template.md"), resolver), (error: unknown) => {
      assert.match(String(error), /only be included from local sources/);
      assert.match(String(error), /-> @\/missing\.md/);
      assert.doesNotMatch(String(error), /http:\/\/[^\n]+\/@\/missing\.md/);
      return true;
    });
  });
});
