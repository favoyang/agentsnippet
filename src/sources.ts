import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { AgentSnippetError } from "./errors.js";
import { GitSourceResolver } from "./git-source.js";
import { loadHttpSource, type FetchImplementation } from "./http-source.js";
import { MAX_SOURCE_BYTES, type SourceContext, type SourceDocument } from "./types.js";

export interface SourceResolverOptions {
  cacheDirectory?: string;
  fetchImplementation?: FetchImplementation;
}

export class SourceResolver {
  readonly git: GitSourceResolver;
  readonly #fetchImplementation: FetchImplementation;

  constructor(options: SourceResolverOptions = {}) {
    this.git = new GitSourceResolver(options.cacheDirectory);
    this.#fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async loadRoot(filePath: string): Promise<SourceDocument> {
    return await this.#loadLocal(resolve(filePath));
  }

  async resolve(reference: string, parent: SourceContext): Promise<SourceDocument> {
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

    const filePath = resolveLocalPath(reference, parent.filePath);
    return await this.#loadLocal(filePath);
  }

  async #loadLocal(filePath: string): Promise<SourceDocument> {
    let metadata;
    try {
      metadata = await stat(filePath);
    } catch {
      throw new AgentSnippetError(`Local source does not exist: ${filePath}`);
    }
    if (!metadata.isFile()) {
      throw new AgentSnippetError(`Local source is not a regular file: ${filePath}`);
    }
    if (metadata.size > MAX_SOURCE_BYTES) {
      throw new AgentSnippetError(`Local source exceeds the ${MAX_SOURCE_BYTES}-byte limit: ${filePath}`);
    }

    const buffer = await readFile(filePath);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new AgentSnippetError(`Local source is not valid UTF-8: ${filePath}`);
    }
    const canonical = await realpath(filePath);
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
  if (reference.startsWith("~/")) return join(homeDirectory, reference.slice(2));
  return isAbsolute(reference) ? reference : resolve(dirname(parentFilePath), reference);
}
