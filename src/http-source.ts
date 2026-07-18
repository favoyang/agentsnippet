import { safeAgentSnippetError } from "./errors.js";
import { redactUrl } from "./git-source.js";
import {
  HTTP_MAX_REDIRECTS,
  HTTP_TIMEOUT_MS,
  MAX_SOURCE_BYTES,
  type SourceDocument,
} from "./types.js";

export type FetchImplementation = typeof fetch;

const SAFE_HTTP_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ETIMEDOUT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

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
          throw safeAgentSnippetError(`HTTP source timed out: ${redactUrl(current)}`, {
            cause: error,
          });
        }
        const detail = safeHttpErrorCodes(error);
        throw safeAgentSnippetError(`Could not fetch HTTP source: ${redactUrl(current)}${detail ? `: ${detail}` : ""}`, {
          cause: error,
        });
      }

      if (isRedirect(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
          throw safeAgentSnippetError(`HTTP redirect has no Location header: ${redactUrl(current)}`);
        }
        if (redirects === HTTP_MAX_REDIRECTS) {
          throw safeAgentSnippetError(`HTTP source exceeded ${HTTP_MAX_REDIRECTS} redirects: ${redactUrl(input)}`);
        }
        const next = validateHttpUrl(new URL(location, current).toString());
        if (new URL(current).protocol === "https:" && new URL(next).protocol !== "https:") {
          throw safeAgentSnippetError(`Refusing an HTTPS-to-HTTP redirect for ${redactUrl(input)}.`);
        }
        current = next;
        continue;
      }

      if (!response.ok) {
        throw safeAgentSnippetError(`HTTP ${response.status} while fetching ${redactUrl(current)}.`);
      }

      const contentLength = response.headers.get("content-length");
      if (contentLength && Number.parseInt(contentLength, 10) > MAX_SOURCE_BYTES) {
        throw safeAgentSnippetError(`HTTP source exceeds the ${MAX_SOURCE_BYTES}-byte limit: ${redactUrl(current)}`);
      }
      const body = await readBoundedBody(response, current);
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(body);
      } catch (error) {
        throw safeAgentSnippetError(`HTTP source is not valid UTF-8: ${redactUrl(current)}`, {
          cause: error,
        });
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

  throw safeAgentSnippetError(`Could not fetch HTTP source: ${redactUrl(input)}`);
}

function safeHttpErrorCodes(error: unknown): string {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    try {
      if (typeof current !== "object" || current === null) break;
      const code = Reflect.get(current, "code") as unknown;
      if (typeof code === "string" && SAFE_HTTP_ERROR_CODES.has(code)) codes.push(code);
      current = Reflect.get(current, "cause") as unknown;
    } catch {
      break;
    }
  }
  return [...new Set(codes)].join(", ");
}

function validateHttpUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw safeAgentSnippetError(`Invalid HTTP source: ${redactUrl(value)}`, { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw safeAgentSnippetError(`Unsupported HTTP protocol: ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw safeAgentSnippetError(`Credentials are not allowed in direct HTTP source URLs: ${redactUrl(value)}`);
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
      const primary = safeAgentSnippetError(
        `HTTP source exceeds the ${MAX_SOURCE_BYTES}-byte limit: ${redactUrl(url)}`,
      );
      try {
        await reader.cancel();
      } catch (cancelError) {
        const combined = new AggregateError(
          [primary, cancelError],
          "HTTP body limit and cancellation both failed.",
          { cause: primary },
        );
        throw safeAgentSnippetError(primary.message, { cause: combined });
      }
      throw primary;
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
