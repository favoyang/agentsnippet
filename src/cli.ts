#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverTemplates } from "./discovery.js";
import { AgentSnippetError, UsageError } from "./errors.js";
import { inspectOutputs, writeOutputsAtomically } from "./output.js";
import { renderTemplate } from "./render.js";
import { SourceResolver } from "./sources.js";
import { TEMPLATE_NAME } from "./types.js";

export interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
  cwd: string;
}

interface CliOptions {
  directory: string;
  recursive: boolean;
  check: boolean;
  help: boolean;
  version: boolean;
}

const HELP = `Usage: agentsnippet [options] [directory]

Expand AGENTS.template.md into a sibling AGENTS.md.

Arguments:
  directory          Directory to process (default: current directory)

Options:
  -r, --recursive    Process nested AGENTS.template.md files
      --check        Verify outputs without writing files
  -h, --help         Show help
  -v, --version      Show version`;

export async function runCli(
  argv: string[],
  io: CliIo = {
    stdout: (message) => console.log(message),
    stderr: (message) => console.error(message),
    cwd: process.cwd(),
  },
): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArguments(argv);
  } catch (error) {
    io.stderr(`agentsnippet: ${error instanceof Error ? error.message : String(error)}`);
    io.stderr("Run 'agentsnippet --help' for usage.");
    return 2;
  }

  if (options.help) {
    io.stdout(HELP);
    return 0;
  }
  if (options.version) {
    io.stdout(await packageVersion());
    return 0;
  }

  const directory = resolve(io.cwd, options.directory);
  try {
    const templates = await discoverTemplates(directory, options.recursive);
    if (templates.length === 0) {
      const suggestion = options.recursive ? "" : " Use -r to search subdirectories.";
      const displayedDirectory = displayPath(directory, io.cwd);
      const location = displayedDirectory === "." ? "the current directory" : `"${displayedDirectory}"`;
      throw new AgentSnippetError(`No ${TEMPLATE_NAME} found in ${location}.${suggestion}`);
    }

    const resolver = new SourceResolver();
    const rendered = [];
    for (const template of templates) {
      rendered.push(await renderTemplate(template, resolver));
    }
    const statuses = await inspectOutputs(rendered);
    const changed = statuses.filter((status) => status.state !== "current");

    if (options.check) {
      if (changed.length === 0) {
        io.stdout(templates.length === 1 ? "AGENTS.md is up to date." : `${templates.length} AGENTS.md files are up to date.`);
        return 0;
      }
      for (const output of changed) {
        io.stderr(`${output.state}: ${displayPath(output.outputPath, io.cwd)}`);
      }
      return 1;
    }

    await writeOutputsAtomically(statuses);
    if (changed.length === 0) {
      io.stdout(templates.length === 1 ? "AGENTS.md is up to date." : `${templates.length} AGENTS.md files are up to date.`);
    } else if (changed.length === 1) {
      io.stdout(`Generated ${displayPath(changed[0]!.outputPath, io.cwd)}.`);
    } else {
      io.stdout(`Generated ${changed.length} AGENTS.md files.`);
    }
    return 0;
  } catch (error) {
    io.stderr(`agentsnippet: ${error instanceof Error ? error.message : String(error)}`);
    return error instanceof UsageError ? 2 : 1;
  }
}

function parseArguments(argv: string[]): CliOptions {
  let recursive = false;
  let check = false;
  let help = false;
  let version = false;
  let positionalOnly = false;
  const directories: string[] = [];

  for (const argument of argv) {
    if (!positionalOnly && argument === "--") {
      positionalOnly = true;
    } else if (!positionalOnly && (argument === "-r" || argument === "--recursive")) {
      recursive = true;
    } else if (!positionalOnly && argument === "--check") {
      check = true;
    } else if (!positionalOnly && (argument === "-h" || argument === "--help")) {
      help = true;
    } else if (!positionalOnly && (argument === "-v" || argument === "--version")) {
      version = true;
    } else if (!positionalOnly && argument.startsWith("-")) {
      throw new UsageError(`Unknown option: ${argument}`);
    } else {
      directories.push(argument);
    }
  }

  if (directories.length > 1) throw new UsageError("Only one directory may be provided.");
  return {
    directory: directories[0] ?? ".",
    recursive,
    check,
    help,
    version,
  };
}

async function packageVersion(): Promise<string> {
  const packageUrl = new URL("../package.json", import.meta.url);
  const packageJson = JSON.parse(await readFile(packageUrl, "utf8")) as { version?: unknown };
  if (typeof packageJson.version !== "string") throw new AgentSnippetError("Package version is unavailable.");
  return packageJson.version;
}

function displayPath(filePath: string, cwd: string): string {
  const pathFromCwd = relative(cwd, filePath);
  if (!pathFromCwd) return ".";
  return pathFromCwd.startsWith("..") ? filePath : pathFromCwd;
}

const isEntryPoint = process.argv[1] && isSameFile(fileURLToPath(import.meta.url), process.argv[1]);
if (isEntryPoint) {
  process.exitCode = await runCli(process.argv.slice(2));
}

function isSameFile(modulePath: string, argumentPath: string): boolean {
  try {
    return realpathSync(modulePath) === realpathSync(resolve(argumentPath));
  } catch {
    return false;
  }
}
