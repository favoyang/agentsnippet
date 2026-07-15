import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function temporaryDirectory(context: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentsnippet-test-"));
  context.after(async () => await rm(directory, { recursive: true, force: true }));
  return directory;
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "agentsnippet tests",
      GIT_AUTHOR_EMAIL: "tests@example.invalid",
      GIT_COMMITTER_NAME: "agentsnippet tests",
      GIT_COMMITTER_EMAIL: "tests@example.invalid",
    },
  });
  return result.stdout.trim();
}
