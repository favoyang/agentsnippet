import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { runCli, type CliIo } from "../src/cli.js";
import { temporaryDirectory } from "./helpers.js";

const execFileAsync = promisify(execFile);

function captureIo(cwd: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    cwd,
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  };
  return { io, stdout, stderr };
}

describe("CLI", () => {
  it("generates only the current directory by default and descendants with -r", async (context) => {
    const directory = await temporaryDirectory(context);
    await mkdir(join(directory, "nested"));
    await writeFile(join(directory, "AGENTS.template.md"), "# Root\n");
    await writeFile(join(directory, "nested", "AGENTS.template.md"), "# Nested\n");

    const first = captureIo(directory);
    assert.equal(await runCli([], first.io), 0);
    assert.equal(await readFile(join(directory, "AGENTS.md"), "utf8"), "# Root\n");
    await assert.rejects(readFile(join(directory, "nested", "AGENTS.md")), /ENOENT/);

    const recursive = captureIo(directory);
    assert.equal(await runCli(["-r"], recursive.io), 0);
    assert.deepEqual(recursive.stdout, ["Generated nested/AGENTS.md."]);
    assert.equal(await readFile(join(directory, "nested", "AGENTS.md"), "utf8"), "# Nested\n");
  });

  it("preserves plural messages for AGENTS-only recursive runs", async (context) => {
    const directory = await temporaryDirectory(context);
    await mkdir(join(directory, "nested"));
    await writeFile(join(directory, "AGENTS.template.md"), "# Root\n");
    await writeFile(join(directory, "nested", "AGENTS.template.md"), "# Nested\n");

    const generated = captureIo(directory);
    assert.equal(await runCli(["-r"], generated.io), 0);
    assert.deepEqual(generated.stdout, ["Generated 2 AGENTS.md files."]);

    const check = captureIo(directory);
    assert.equal(await runCli(["--check", "-r"], check.io), 0);
    assert.deepEqual(check.stdout, ["2 AGENTS.md files are up to date."]);
  });

  it("generates CLAUDE.md from CLAUDE.template.md", async (context) => {
    const directory = await temporaryDirectory(context);
    await writeFile(join(directory, "CLAUDE.template.md"), "# Claude instructions\n");

    const captured = captureIo(directory);
    assert.equal(await runCli([], captured.io), 0);
    assert.deepEqual(captured.stdout, ["Generated CLAUDE.md."]);
    assert.equal(await readFile(join(directory, "CLAUDE.md"), "utf8"), "# Claude instructions\n");
  });

  it("generates AGENTS.md and CLAUDE.md together", async (context) => {
    const directory = await temporaryDirectory(context);
    await writeFile(join(directory, "AGENTS.template.md"), "# Shared instructions\n");
    await writeFile(join(directory, "CLAUDE.template.md"), "# Claude instructions\n");

    const captured = captureIo(directory);
    assert.equal(await runCli([], captured.io), 0);
    assert.deepEqual(captured.stdout, ["Generated 2 instruction files."]);
    assert.equal(await readFile(join(directory, "AGENTS.md"), "utf8"), "# Shared instructions\n");
    assert.equal(await readFile(join(directory, "CLAUDE.md"), "utf8"), "# Claude instructions\n");

    const check = captureIo(directory);
    assert.equal(await runCli(["--check"], check.io), 0);
    assert.deepEqual(check.stdout, ["2 instruction files are up to date."]);
  });

  it("accepts an optional working directory", async (context) => {
    const directory = await temporaryDirectory(context);
    const project = join(directory, "project");
    await mkdir(project);
    await writeFile(join(project, "AGENTS.template.md"), "# Project\n");
    const captured = captureIo(directory);
    assert.equal(await runCli(["project"], captured.io), 0);
    assert.equal(await readFile(join(project, "AGENTS.md"), "utf8"), "# Project\n");
  });

  it("checks stale output without writing", async (context) => {
    const directory = await temporaryDirectory(context);
    await writeFile(join(directory, "AGENTS.template.md"), "# Initial\n");
    assert.equal(await runCli([], captureIo(directory).io), 0);
    await writeFile(join(directory, "AGENTS.template.md"), "# Changed\n");

    const captured = captureIo(directory);
    assert.equal(await runCli(["--check"], captured.io), 1);
    assert.deepEqual(captured.stderr, ["stale: AGENTS.md"]);
    assert.equal(await readFile(join(directory, "AGENTS.md"), "utf8"), "# Initial\n");
  });

  it("reports a missing output in check mode", async (context) => {
    const directory = await temporaryDirectory(context);
    await writeFile(join(directory, "AGENTS.template.md"), "# Missing output\n");
    const captured = captureIo(directory);
    assert.equal(await runCli(["--check"], captured.io), 1);
    assert.deepEqual(captured.stderr, ["missing: AGENTS.md"]);
    await assert.rejects(readFile(join(directory, "AGENTS.md")), /ENOENT/);
  });

  it("renders every recursive template before changing any output", async (context) => {
    const directory = await temporaryDirectory(context);
    await mkdir(join(directory, "nested"));
    await writeFile(join(directory, "AGENTS.template.md"), "# New root\n");
    await writeFile(join(directory, "AGENTS.md"), "# Existing root\n");
    await writeFile(
      join(directory, "nested", "AGENTS.template.md"),
      '<!-- @agentsnippet "./missing.md" -->\n',
    );

    const captured = captureIo(directory);
    assert.equal(await runCli(["-r"], captured.io), 1);
    assert.equal(await readFile(join(directory, "AGENTS.md"), "utf8"), "# Existing root\n");
    await assert.rejects(readFile(join(directory, "nested", "AGENTS.md")), /ENOENT/);
  });

  it("returns usage errors and suggests recursion when no template exists", async (context) => {
    const directory = await temporaryDirectory(context);
    const unknown = captureIo(directory);
    assert.equal(await runCli(["--unknown"], unknown.io), 2);
    assert.match(unknown.stderr.join("\n"), /Unknown option/);

    const missing = captureIo(directory);
    assert.equal(await runCli([], missing.io), 1);
    assert.deepEqual(missing.stderr, [
      "agentsnippet: No AGENTS.template.md or CLAUDE.template.md found in the current directory. Use -r to search subdirectories.",
    ]);
  });

  it("reports local snippet read failures consistently", async (context) => {
    const directory = await temporaryDirectory(context);
    await writeFile(
      join(directory, "AGENTS.template.md"),
      '<!-- @agentsnippet "./missing.md" -->\n',
    );
    const captured = captureIo(directory);
    assert.equal(await runCli([], captured.io), 1);
    assert.match(captured.stderr.join("\n"), /Could not read snippet "\.\/missing\.md"/);
    assert.match(captured.stderr.join("\n"), /Local source does not exist/);
  });

  it("runs through an npm-style symlinked executable", async (context) => {
    if (process.platform === "win32") context.skip("npm uses command shims instead of symlinks on Windows");
    const directory = await temporaryDirectory(context);
    const binary = join(directory, "agentsnippet");
    const { symlink } = await import("node:fs/promises");
    await symlink(join(process.cwd(), "dist", "cli.js"), binary);
    const result = await execFileAsync(process.execPath, [binary, "--version"], { encoding: "utf8" });
    const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
      version: string;
    };
    assert.equal(result.stdout.trim(), packageJson.version);
  });
});
