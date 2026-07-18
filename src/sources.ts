import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  AgentSnippetError,
  isSafeAgentSnippetError,
  safeAgentSnippetError,
} from "./errors.js";
import { GitSourceResolver, redactUrl } from "./git-source.js";
import { loadHttpSource, type FetchImplementation } from "./http-source.js";
import { MAX_SOURCE_BYTES, type SourceContext, type SourceDocument } from "./types.js";

export interface SourceResolverOptions {
  cacheDirectory?: string;
  fetchImplementation?: FetchImplementation;
  homeDirectory?: string;
}

export class SourceResolver {
  readonly git: GitSourceResolver;
  readonly #fetchImplementation: FetchImplementation;
  readonly #homeDirectory: string;

  constructor(options: SourceResolverOptions = {}) {
    this.git = new GitSourceResolver(options.cacheDirectory);
    this.#fetchImplementation = options.fetchImplementation ?? fetch;
    this.#homeDirectory = options.homeDirectory ?? homedir();
  }

  async loadRoot(filePath: string): Promise<SourceDocument> {
    const resolvedPath = resolve(filePath);
    try {
      return await this.#loadLocal(resolvedPath);
    } catch (error) {
      const detail = isSafeAgentSnippetError(error)
        ? error.message
        : "Backend source read failed.";
      throw safeAgentSnippetError(
        `Could not read root template ${resolvedPath}: ${detail}`,
        { cause: error },
      );
    }
  }

  async resolve(reference: string, parent: SourceContext): Promise<SourceDocument> {
    try {
      if (reference.startsWith("@/")) {
        if (parent.kind !== "local") {
          throw safeAgentSnippetError("Magic-folder snippets can only be included from local sources.");
        }
        const root = magicDirectory(this.#homeDirectory);
        return await this.#loadLocal(resolveLocalPath(reference, localParentPath(parent), this.#homeDirectory), root);
      }
      if (reference.startsWith("git+https://") || reference.startsWith("git+ssh://")) {
        return await this.git.resolve(reference);
      }
      if (reference.startsWith("http://") || reference.startsWith("https://")) {
        return await loadHttpSource(reference, this.#fetchImplementation);
      }

      if (parent.kind === "http") {
        return await loadHttpSource(new URL(reference, parent.url).toString(), this.#fetchImplementation);
      }
      if (parent.kind === "git") {
        return await this.git.resolveRelative(reference, parent);
      }

      const filePath = resolveLocalPath(reference, parent.filePath, this.#homeDirectory);
      return await this.#loadLocal(filePath);
    } catch (error) {
      const detail = isSafeAgentSnippetError(error)
        ? error.message
        : "Backend source read failed.";
      throw safeAgentSnippetError(`Could not read snippet ${displayReference(reference, parent)}: ${detail}`, {
        cause: error,
      });
    }
  }

  async #loadLocal(filePath: string, allowedRoot?: string): Promise<SourceDocument> {
    let canonical: string;
    try {
      canonical = await realpath(filePath);
    } catch (error) {
      throw localAccessError(error, filePath, "inspect");
    }

    if (allowedRoot) {
      const canonicalRoot = await realpath(allowedRoot);
      if (!isWithin(canonicalRoot, canonical)) {
        throw safeAgentSnippetError(`Magic-folder source escapes ${allowedRoot}: ${filePath}`);
      }
    }

    let handle;
    try {
      handle = await open(
        canonical,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      throw localAccessError(error, filePath, "open");
    }

    let buffer: Buffer | undefined;
    let primaryError: unknown;
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) {
        throw safeAgentSnippetError(`Local source is not a regular file: ${filePath}`);
      }
      if (metadata.size > MAX_SOURCE_BYTES) {
        throw safeAgentSnippetError(`Local source exceeds the ${MAX_SOURCE_BYTES}-byte limit: ${filePath}`);
      }
      buffer = await readBoundedLocal(handle, filePath);
    } catch (error) {
      primaryError = error;
    }
    try {
      await handle.close();
    } catch (closeError) {
      if (primaryError !== undefined) {
        const combined = new AggregateError(
          [primaryError, closeError],
          "Local source read and close both failed.",
          { cause: primaryError },
        );
        if (isSafeAgentSnippetError(primaryError)) {
          throw safeAgentSnippetError(primaryError.message, { cause: combined });
        }
        throw combined;
      }
      throw closeError;
    }
    if (primaryError !== undefined) throw primaryError;
    if (!buffer) throw new Error("Local source read completed without a buffer.");
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch (error) {
      throw safeAgentSnippetError(`Local source is not valid UTF-8: ${filePath}`, {
        cause: error,
      });
    }
    return {
      content,
      context: { kind: "local", filePath },
      key: `file:${canonical}`,
      display: filePath,
    };
  }
}

export function resolveLocalPath(
  reference: string,
  parentFilePath: string,
  homeDirectory = homedir(),
): string {
  if (reference.startsWith("@/")) {
    const root = magicDirectory(homeDirectory);
    const candidate = resolve(root, reference.slice(2));
    if (!isWithin(root, candidate)) {
      throw safeAgentSnippetError(`Magic-folder source escapes ${root}: ${reference}`);
    }
    return candidate;
  }
  if (reference.startsWith("~/")) return join(homeDirectory, reference.slice(2));
  return isAbsolute(reference) ? reference : resolve(dirname(parentFilePath), reference);
}

function localParentPath(parent: SourceContext): string {
  return parent.kind === "local" ? parent.filePath : join(homedir(), "AGENTS.template.md");
}

function displayReference(reference: string, parent: SourceContext): string {
  if (parent.kind === "http" && !reference.startsWith("@/")) {
    try {
      return JSON.stringify(redactUrl(new URL(reference, parent.url).toString()));
    } catch {
      return '"<redacted-source>"';
    }
  }
  if (
    reference.startsWith("http://") ||
    reference.startsWith("https://") ||
    reference.startsWith("git+https://") ||
    reference.startsWith("git+ssh://")
  ) {
    return JSON.stringify(redactUrl(reference));
  }
  return JSON.stringify(reference);
}

function localAccessError(error: unknown, filePath: string, action: string): AgentSnippetError {
  const code = safeErrorCode(error);
  if (code === "ENOENT" || code === "ENOTDIR") {
    return safeAgentSnippetError(`Local source does not exist: ${filePath}`, { cause: error });
  }
  const safeCode = code && SAFE_LOCAL_ERROR_CODES.has(code) ? ` (${code})` : "";
  return safeAgentSnippetError(`Could not ${action} local source ${filePath}${safeCode}.`, {
    cause: error,
  });
}

function safeErrorCode(error: unknown): string | undefined {
  try {
    if (typeof error !== "object" || error === null) return undefined;
    const code = Reflect.get(error, "code") as unknown;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

const SAFE_LOCAL_ERROR_CODES = new Set([
  "EACCES",
  "EBUSY",
  "EIO",
  "ELOOP",
  "EMFILE",
  "ENAMETOOLONG",
  "ENFILE",
  "EPERM",
  "EROFS",
]);

async function readBoundedLocal(
  handle: Awaited<ReturnType<typeof open>>,
  filePath: string,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(MAX_SOURCE_BYTES + 1);
  let bytes = 0;
  while (bytes < buffer.length) {
    const result = await handle.read(buffer, bytes, buffer.length - bytes, null);
    if (result.bytesRead === 0) break;
    bytes += result.bytesRead;
  }
  if (bytes > MAX_SOURCE_BYTES) {
    throw safeAgentSnippetError(`Local source exceeds the ${MAX_SOURCE_BYTES}-byte limit: ${filePath}`);
  }
  return buffer.subarray(0, bytes);
}

function magicDirectory(homeDirectory: string): string {
  return resolve(homeDirectory, ".agents", "agentsnippets");
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}
