import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { writeOutputsAtomically, type OutputStatus } from "../src/output.js";
import { temporaryDirectory } from "./helpers.js";

describe("generated output", () => {
  it("honors the process umask when creating a file", async (context) => {
    if (process.platform === "win32") context.skip("Windows does not use POSIX permission bits");
    const directory = await temporaryDirectory(context);
    const outputPath = join(directory, "AGENTS.md");
    const output: OutputStatus = {
      templatePath: join(directory, "AGENTS.template.md"),
      outputPath,
      content: "Generated.\n",
      state: "missing",
    };
    const previousUmask = process.umask(0o077);
    try {
      await writeOutputsAtomically([output]);
    } finally {
      process.umask(previousUmask);
    }

    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  });
});
