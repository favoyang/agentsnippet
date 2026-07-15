import { AgentSnippetError } from "./errors.js";
import { redactUrl } from "./git-source.js";
import {
  HTTP_MAX_REDIRECTS,
  HTTP_TIMEOUT_MS,
  MAX_SOURCE_BYTES,
  type SourceDocument,
} from "./types.js";

export type FetchImplementation = typeof fetch;

export async function loadHttpSource(
  input: string,
  fetchImplementation: FetchImplementation = fetch,
): Promise<SourceDocument> {
  let current = validateHttpUrl(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  try {
    for (let redirects = 0; redirects <= HTTP_MAX_REDIRECTS; redirects += 1) {
      let response: Response;
      try {
        response = await fetchImplementation(current, {
          redirect: "manual",
          signal: controller.signal,
          headers: { Accept: "text/markdown,text/plain;q=0.9,*/*;q=0.1" },
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new AgentSnippetError(`HTTP source timed out: ${redactUrl(current)}`);
        }
        throw new AgentSnippetError(`Could not fetch HTTP source: ${redactUrl(current)}`, {
          cause: error,
        });
      }

      if (isRedirect(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
          throw new AgentSnippetError(`HTTP redirect has no Location header: ${redactUrl(current)}`);
        }
        if (redirects === HTTP_MAX_REDIRECTS) {
          throw new AgentSnippetError(`HTTP source exceeded ${HTTP_MAX_REDIRECTS} redirects: ${redactUrl(input)}`);
        }
        const next = validateHttpUrl(new URL(location, current).toString());
        if (new URL(current).protocol === "https:" && new URL(next).protocol !== "https:") {
          throw new AgentSnippetError(`Refusing an HTTPS-to-HTTP redirect for ${redactUrl(input)}.`);
        }
        current = next;
        continue;
      }

      if (!response.ok) {
        throw new AgentSnippetError(`HTTP ${response.status} while fetching ${redactUrl(current)}.`);
      }

      const contentLength = response.headers.get("content-length");
      if (contentLength && Number.parseInt(contentLength, 10) > MAX_SOURCE_BYTES) {
        throw new AgentSnippetError(`HTTP source exceeds the ${MAX_SOURCE_BYTES}-byte limit: ${redactUrl(current)}`);
      }
      const body = await readBoundedBody(response, current);
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(body);
      } catch {
        throw new AgentSnippetError(`HTTP source is not valid UTF-8: ${redactUrl(current)}`);
      }
      return {
        content,
        context: { kind: "http", url: current },
        key: `http:${current}`,
        display: redactUrl(current),
      };
    }
  } finally {
    clearTimeout(timer);
  }

  throw new AgentSnippetError(`Could not fetch HTTP source: ${redactUrl(input)}`);
}

function validateHttpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AgentSnippetError(`Invalid HTTP source: ${redactUrl(value)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AgentSnippetError(`Unsupported HTTP protocol: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new AgentSnippetError(`Credentials are not allowed in direct HTTP source URLs: ${redactUrl(value)}`);
  }
  url.hash = "";
  return url.toString();
}

async function readBoundedBody(response: Response, url: string): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_SOURCE_BYTES) {
      await reader.cancel();
      throw new AgentSnippetError(`HTTP source exceeds the ${MAX_SOURCE_BYTES}-byte limit: ${redactUrl(url)}`);
    }
    chunks.push(value);
  }

  const result = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
