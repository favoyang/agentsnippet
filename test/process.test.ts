import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runProcess } from "../src/process.js";

describe("process failures", () => {
  it("keeps spawn backend details in the cause", async () => {
    await assert.rejects(
      runProcess("git", ["--version"], { env: { PATH: "/nonexistent" } }),
      (error: unknown) => {
        assert.equal(String(error), "AgentSnippetError: Could not start git.");
        assert.doesNotMatch(String(error), /ENOENT|spawn/);
        assert(error instanceof Error && error.cause instanceof Error);
        return true;
      },
    );
  });
});
