import assert from "node:assert/strict";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { discoverTemplates } from "../src/discovery.js";
import { git, temporaryDirectory } from "./helpers.js";

describe("template discovery", () => {
  it("processes only the selected directory unless recursive", async (context) => {
    const directory = await temporaryDirectory(context);
    await mkdir(join(directory, "nested"));
    await writeFile(join(directory, "AGENTS.template.md"), "root\n");
    await writeFile(join(directory, "nested", "AGENTS.template.md"), "nested\n");

    assert.deepEqual(await discoverTemplates(directory, false), [join(directory, "AGENTS.template.md")]);
    assert.deepEqual(await discoverTemplates(directory, true), [
      join(directory, "AGENTS.template.md"),
      join(directory, "nested", "AGENTS.template.md"),
    ]);
  });

  it("discovers AGENTS and CLAUDE templates in the same directory", async (context) => {
    const directory = await temporaryDirectory(context);
    await writeFile(join(directory, "AGENTS.template.md"), "agents\n");
    await writeFile(join(directory, "CLAUDE.template.md"), "claude\n");

    assert.deepEqual(await discoverTemplates(directory, false), [
      join(directory, "AGENTS.template.md"),
      join(directory, "CLAUDE.template.md"),
    ]);
  });

  it("honors Git ignore rules and does not follow directory symlinks", async (context) => {
    const directory = await temporaryDirectory(context);
    await git(directory, "init", "--quiet");
    await mkdir(join(directory, "kept"));
    await mkdir(join(directory, "ignored"));
    await writeFile(join(directory, ".gitignore"), "ignored/\n");
    await writeFile(join(directory, "kept", "AGENTS.template.md"), "kept\n");
    await writeFile(join(directory, "kept", "CLAUDE.template.md"), "claude\n");
    await writeFile(join(directory, "ignored", "AGENTS.template.md"), "ignored\n");
    await symlink(join(directory, "kept"), join(directory, "linked"), "dir");
    await symlink(join(directory, "kept", "AGENTS.template.md"), join(directory, "AGENTS.template.md"), "file");

    assert.deepEqual(await discoverTemplates(directory, true), [
      join(directory, "AGENTS.template.md"),
      join(directory, "kept", "AGENTS.template.md"),
      join(directory, "kept", "CLAUDE.template.md"),
    ]);
  });

  it("honors ignore rules in a Git repository nested under a non-Git directory", async (context) => {
    const directory = await temporaryDirectory(context);
    const repository = join(directory, "repository");
    await mkdir(repository);
    await git(repository, "init", "--quiet");
    await mkdir(join(repository, "kept"));
    await mkdir(join(repository, "ignored"));
    await writeFile(join(repository, ".gitignore"), "ignored/\n");
    await writeFile(join(repository, "kept", "AGENTS.template.md"), "kept\n");
    await writeFile(join(repository, "ignored", "AGENTS.template.md"), "ignored\n");

    assert.deepEqual(await discoverTemplates(directory, true), [
      join(repository, "kept", "AGENTS.template.md"),
    ]);
  });

  it("discovers templates inside populated Git submodules", async (context) => {
    const directory = await temporaryDirectory(context);
    const nested = join(directory, "nested");
    await git(directory, "init", "--quiet");
    await mkdir(nested);
    await git(nested, "init", "--quiet");
    await writeFile(join(nested, "AGENTS.template.md"), "nested\n");
    await git(nested, "add", ".");
    await git(nested, "commit", "--quiet", "-m", "fixture");
    await git(directory, "add", "nested");

    assert.deepEqual(await discoverTemplates(directory, true), [
      join(nested, "AGENTS.template.md"),
    ]);
  });

  it("skips uninitialized Git submodule directories", { timeout: 1_000 }, async (context) => {
    const directory = await temporaryDirectory(context);
    const nested = join(directory, "nested");
    await git(directory, "init", "--quiet");
    await mkdir(nested);
    await git(nested, "init", "--quiet");
    await writeFile(join(nested, "AGENTS.template.md"), "nested\n");
    await git(nested, "add", ".");
    await git(nested, "commit", "--quiet", "-m", "fixture");
    await git(directory, "add", "nested");
    await rm(nested, { recursive: true });
    await mkdir(nested);

    assert.deepEqual(await discoverTemplates(directory, true), []);
  });
});
