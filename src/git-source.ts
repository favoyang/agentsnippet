import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, posix } from "node:path";
import { AgentSnippetError, safeAgentSnippetError } from "./errors.js";
import { runProcess, type ProcessResult } from "./process.js";
import { MAX_SOURCE_BYTES, type GitContext, type SourceDocument } from "./types.js";

const GIT_TIMEOUT_MS = 60_000;
const FULL_COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export interface ParsedGitSource {
  repositoryUrl: string;
  repositoryDisplay: string;
  ref: string;
  filePath: string;
}

export class GitSourceResolver {
  readonly cacheDirectory: string;
  readonly #resolvedRefs = new Map<string, Promise<{ cachePath: string; commit: string }>>();

  constructor(cacheDirectory = defaultCacheDirectory()) {
    this.cacheDirectory = cacheDirectory;
  }

  async resolve(reference: string): Promise<SourceDocument> {
    const parsed = parseGitSource(reference);
    const refKey = `${parsed.repositoryUrl}\0${parsed.ref}`;
    let resolved = this.#resolvedRefs.get(refKey);
    if (!resolved) {
      resolved = this.#resolveRef(parsed);
      this.#resolvedRefs.set(refKey, resolved);
    }

    const { cachePath, commit } = await resolved;
    return await this.readFromContext(
      {
        kind: "git",
        repositoryUrl: parsed.repositoryUrl,
        repositoryDisplay: parsed.repositoryDisplay,
        repositoryCachePath: cachePath,
        commit,
        filePath: normalizeRepositoryPath(parsed.filePath),
      },
      parsed.filePath,
    );
  }

  async resolveRelative(reference: string, parent: GitContext): Promise<SourceDocument> {
    if (reference.startsWith("/")) {
      throw safeAgentSnippetError(`Git include paths must be repository-relative: ${reference}`);
    }
    const filePath = normalizeRepositoryPath(posix.join(posix.dirname(parent.filePath), reference));
    return await this.readFromContext({ ...parent, filePath }, filePath);
  }

  async readFromContext(context: GitContext, displayPath = context.filePath): Promise<SourceDocument> {
    const filePath = normalizeRepositoryPath(context.filePath);
    const treeEntry = await git(context.repositoryCachePath, [
      "ls-tree",
      "-z",
      context.commit,
      "--",
      filePath,
    ]);
    if (treeEntry.stdout.length === 0) {
      throw safeAgentSnippetError(
        `Git source does not contain ${displayPath} at ${shortCommit(context.commit)} ` +
          `in ${context.repositoryDisplay}.`,
      );
    }

    const metadata = treeEntry.stdout.subarray(0, treeEntry.stdout.indexOf(0)).toString("utf8");
    const tabIndex = metadata.indexOf("\t");
    const header = tabIndex === -1 ? metadata : metadata.slice(0, tabIndex);
    const [mode, type] = header.split(/\s+/, 3);
    if (mode === "120000") {
      throw safeAgentSnippetError(`Git source path is a symlink and cannot be included: ${displayPath}`);
    }
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
      throw safeAgentSnippetError(`Git source path is not a regular file: ${displayPath}`);
    }

    const objectName = `${context.commit}:${filePath}`;
    const sizeResult = await git(context.repositoryCachePath, ["cat-file", "-s", objectName]);
    const size = Number.parseInt(sizeResult.stdout.toString("utf8").trim(), 10);
    if (!Number.isSafeInteger(size) || size > MAX_SOURCE_BYTES) {
      throw safeAgentSnippetError(
        `Git source exceeds the ${MAX_SOURCE_BYTES}-byte limit: ${displayPath}`,
      );
    }

    const blob = await git(context.repositoryCachePath, ["cat-file", "blob", objectName], {
      maxOutputBytes: MAX_SOURCE_BYTES + 1,
    });
    const content = decodeUtf8(blob.stdout, `${context.repositoryDisplay}#${shortCommit(context.commit)}:${filePath}`);
    const nextContext: GitContext = { ...context, filePath };
    const display = `${context.repositoryDisplay}#${shortCommit(context.commit)}:${filePath}`;
    return {
      content,
      context: nextContext,
      key: `git:${hash(context.repositoryUrl)}:${context.commit}:${filePath}`,
      display,
    };
  }

  async #resolveRef(parsed: ParsedGitSource): Promise<{ cachePath: string; commit: string }> {
    const cachePath = join(this.cacheDirectory, "git", hash(parsed.repositoryUrl));
    await mkdir(dirname(cachePath), { recursive: true });
    if (!(await isBareRepository(cachePath))) {
      await mkdir(cachePath, { recursive: true });
      const objectFormat = await remoteObjectFormat(parsed);
      const initialized = await runProcess("git", [
        "init",
        "--bare",
        "--quiet",
        `--object-format=${objectFormat}`,
        cachePath,
      ], {
        timeoutMs: GIT_TIMEOUT_MS,
      });
      if (initialized.code !== 0) {
        throw safeAgentSnippetError(`Could not initialize the agentsnippet Git cache.`, {
          cause: gitBackendError(initialized),
        });
      }
    }

    if (FULL_COMMIT_PATTERN.test(parsed.ref)) {
      const cached = await git(cachePath, ["cat-file", "-e", `${parsed.ref}^{commit}`], {
        allowFailure: true,
      });
      if (cached.code === 0) {
        const commit = await revParse(cachePath, parsed.ref);
        return { cachePath, commit };
      }
    }

    if (parsed.ref.startsWith("-")) {
      throw safeAgentSnippetError(`Git refs cannot begin with '-': ${parsed.ref}`);
    }
    const fetched = await runProcess(
      "git",
      ["-C", cachePath, "fetch", "--quiet", "--depth=1", "--no-tags", parsed.repositoryUrl, parsed.ref],
      { timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: 1024 * 1024 },
    );
    if (fetched.code !== 0) {
      throw safeAgentSnippetError(`Could not fetch ${parsed.ref} from ${parsed.repositoryDisplay}.`, {
        cause: gitBackendError(fetched),
      });
    }

    const commit = await revParse(cachePath, "FETCH_HEAD");
    return { cachePath, commit };
  }
}

async function remoteObjectFormat(parsed: ParsedGitSource): Promise<"sha1" | "sha256"> {
  const result = await runProcess(
    "git",
    ["ls-remote", "--symref", parsed.repositoryUrl, "HEAD", parsed.ref],
    { timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: 1024 * 1024 },
  );
  if (result.code !== 0) {
    throw safeAgentSnippetError(`Could not inspect ${parsed.repositoryDisplay}.`, {
      cause: gitBackendError(result),
    });
  }

  const objectId = result.stdout.toString("utf8").match(/^([0-9a-f]{40}|[0-9a-f]{64})\s/im)?.[1];
  return objectId?.length === 64 ? "sha256" : "sha1";
}

interface GitOptions {
  allowFailure?: boolean;
  maxOutputBytes?: number;
}

async function git(cachePath: string, args: string[], options: GitOptions = {}) {
  const processOptions: Parameters<typeof runProcess>[2] = {
    timeoutMs: GIT_TIMEOUT_MS,
  };
  if (options.maxOutputBytes !== undefined) processOptions.maxOutputBytes = options.maxOutputBytes;
  const result = await runProcess(
    "git",
    ["--literal-pathspecs", "-C", cachePath, ...args],
    processOptions,
  );
  if (result.code !== 0 && !options.allowFailure) {
    throw safeAgentSnippetError("Git command failed.", { cause: gitBackendError(result) });
  }
  return result;
}

async function revParse(cachePath: string, ref: string): Promise<string> {
  const result = await git(cachePath, ["rev-parse", "--verify", `${ref}^{commit}`]);
  return result.stdout.toString("utf8").trim();
}

export function parseGitSource(reference: string): ParsedGitSource {
  if (!reference.startsWith("git+https://") && !reference.startsWith("git+ssh://")) {
    throw safeAgentSnippetError(`Unsupported Git source. Use git+https:// or git+ssh://: ${redactUrl(reference)}`);
  }

  const withoutPrefix = reference.slice(4);
  const hashIndex = withoutPrefix.indexOf("#");
  if (hashIndex <= 0 || hashIndex === withoutPrefix.length - 1) {
    throw invalidGitSource(reference);
  }
  const repositoryUrl = withoutPrefix.slice(0, hashIndex);
  const selector = withoutPrefix.slice(hashIndex + 1);
  const colonIndex = selector.indexOf(":");
  if (colonIndex <= 0 || colonIndex === selector.length - 1) {
    throw invalidGitSource(reference);
  }

  try {
    const url = new URL(repositoryUrl);
    if (url.protocol !== "https:" && url.protocol !== "ssh:") {
      throw new Error("unsupported protocol");
    }
  } catch (error) {
    throw invalidGitSource(reference, { cause: error });
  }

  const ref = selector.slice(0, colonIndex);
  const filePath = normalizeRepositoryPath(selector.slice(colonIndex + 1));
  return {
    repositoryUrl,
    repositoryDisplay: redactUrl(repositoryUrl),
    ref,
    filePath,
  };
}

function invalidGitSource(reference: string, options?: ErrorOptions): AgentSnippetError {
  return safeAgentSnippetError(
    `Invalid Git source ${redactUrl(reference)}. ` +
      "Expected git+<https-or-ssh-url>#<ref>:<repository-path>.",
    options,
  );
}

export function normalizeRepositoryPath(filePath: string): string {
  if (!filePath || filePath.includes("\0") || filePath.startsWith("/")) {
    throw safeAgentSnippetError(`Invalid repository-relative path: ${filePath || "<empty>"}`);
  }
  const normalized = posix.normalize(filePath);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw safeAgentSnippetError(`Git include escapes the repository: ${filePath}`);
  }
  return normalized;
}

export function redactUrl(value: string): string {
  const withoutGitPrefix = value.startsWith("git+") ? value.slice(4) : value;
  const fragmentIndex = withoutGitPrefix.indexOf("#");
  const base = fragmentIndex === -1 ? withoutGitPrefix : withoutGitPrefix.slice(0, fragmentIndex);
  const fragment = fragmentIndex === -1 ? "" : withoutGitPrefix.slice(fragmentIndex);
  try {
    const url = new URL(base);
    url.username = "";
    url.password = "";
    url.search = "";
    return `${url.toString()}${fragment}`;
  } catch {
    return "<redacted-source>";
  }
}

export function sanitizeGitError(message: string, repositoryUrl: string): string {
  void message;
  return `Git command failed for ${redactUrl(repositoryUrl)}.`;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function shortCommit(commit: string): string {
  return commit.slice(0, 12);
}

async function isBareRepository(cachePath: string): Promise<boolean> {
  try {
    const head = await stat(join(cachePath, "HEAD"));
    return head.isFile();
  } catch (error) {
    const code = safeErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw safeAgentSnippetError(`Could not inspect the agentsnippet Git cache.`, {
      cause: error,
    });
  }
}

class GitBackendError extends Error {
  readonly code: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;

  constructor(result: ProcessResult) {
    super(`Git exited with status ${result.code}.`);
    this.name = "GitBackendError";
    this.code = result.code;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
  }
}

function gitBackendError(result: ProcessResult): GitBackendError {
  return new GitBackendError(result);
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

function decodeUtf8(buffer: Buffer, display: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error) {
    throw safeAgentSnippetError(`Source is not valid UTF-8: ${display}`, { cause: error });
  }
}

function defaultCacheDirectory(): string {
  if (process.env.AGENTSNIPPET_CACHE_DIR) return process.env.AGENTSNIPPET_CACHE_DIR;
  if (process.env.XDG_CACHE_HOME) return join(process.env.XDG_CACHE_HOME, "agentsnippet");
  if (platform() === "darwin") return join(homedir(), "Library", "Caches", "agentsnippet");
  if (platform() === "win32" && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, "agentsnippet");
  }
  return join(homedir(), ".cache", "agentsnippet");
}
