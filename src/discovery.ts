import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AgentSnippetError } from "./errors.js";
import { runProcess } from "./process.js";
import { TEMPLATE_NAMES } from "./types.js";

const templateNames = new Set(TEMPLATE_NAMES);

export async function discoverTemplates(directory: string, recursive: boolean): Promise<string[]> {
  const requestedTarget = resolve(directory);
  let metadata;
  try {
    metadata = await stat(requestedTarget);
  } catch {
    throw new AgentSnippetError(`Directory does not exist: ${requestedTarget}`);
  }
  if (!metadata.isDirectory()) {
    throw new AgentSnippetError(`Not a directory: ${requestedTarget}`);
  }
  const target = requestedTarget;
  const canonicalTarget = await realpath(requestedTarget);

  if (!recursive) {
    const templates = await Promise.all(
      TEMPLATE_NAMES.map(async (templateName) => {
        const template = join(target, templateName);
        try {
          const templateMetadata = await stat(template);
          return templateMetadata.isFile() ? template : undefined;
        } catch {
          return undefined;
        }
      }),
    );
    return templates.filter((template): template is string => template !== undefined).sort(comparePaths);
  }

  const gitTemplates = await discoverWithGit(target, canonicalTarget);
  if (gitTemplates) return gitTemplates;

  const templates: string[] = [];
  await walk(target, templates);
  return templates.sort(comparePaths);
}

async function discoverWithGit(target: string, canonicalTarget: string): Promise<string[] | undefined> {
  let rootResult;
  try {
    rootResult = await runProcess("git", ["-C", target, "rev-parse", "--show-toplevel"], {
      timeoutMs: 10_000,
    });
  } catch {
    return undefined;
  }
  if (rootResult.code !== 0) return undefined;
  const root = rootResult.stdout.toString("utf8").trim();
  if (!root) return undefined;

  const filesResult = await runProcess(
    "git",
    ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { timeoutMs: 10_000, maxOutputBytes: 64 * 1024 * 1024 },
  );
  if (filesResult.code !== 0) {
    throw new AgentSnippetError(`Git could not enumerate templates under ${target}.`);
  }

  const templates = new Set<string>();
  for (const repositoryPath of filesResult.stdout.toString("utf8").split("\0")) {
    if (!repositoryPath) continue;
    const absolute = resolve(root, repositoryPath);
    if (!isWithin(canonicalTarget, absolute)) continue;
    try {
      const metadata = await lstat(absolute);
      if (metadata.isDirectory()) {
        if (!(await hasGitMetadata(absolute))) continue;
        for (const nestedTemplate of await discoverTemplates(absolute, true)) {
          templates.add(resolve(target, relative(canonicalTarget, nestedTemplate)));
        }
      } else if (
        templateNames.has(basename(repositoryPath)) &&
        (metadata.isFile() || (metadata.isSymbolicLink() && (await stat(absolute)).isFile()))
      ) {
        templates.add(resolve(target, relative(canonicalTarget, absolute)));
      }
    } catch {
      // A tracked but deleted path is not a discoverable template.
    }
  }
  return [...templates].sort(comparePaths);
}

async function hasGitMetadata(directory: string): Promise<boolean> {
  try {
    const metadata = await lstat(join(directory, ".git"));
    return metadata.isDirectory() || metadata.isFile();
  } catch {
    return false;
  }
}

async function walk(directory: string, templates: string[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (await hasGitMetadata(entryPath)) {
        templates.push(...(await discoverTemplates(entryPath, true)));
      } else {
        await walk(entryPath, templates);
      }
    } else if (templateNames.has(entry.name) && (entry.isFile() || entry.isSymbolicLink())) {
      try {
        if ((await stat(entryPath)).isFile()) templates.push(entryPath);
      } catch {
        // Broken file symlinks are ignored during discovery.
      }
    }
  }
}

function isWithin(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return pathFromParent === "" || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== ".." && !isAbsolute(pathFromParent));
}

function comparePaths(left: string, right: string): number {
  return left.localeCompare(right, "en");
}
