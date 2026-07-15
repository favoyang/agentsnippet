import { randomBytes } from "node:crypto";
import { chmod, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { AgentSnippetError } from "./errors.js";
import type { RenderedOutput } from "./types.js";

export interface OutputStatus extends RenderedOutput {
  state: "current" | "missing" | "stale";
}

interface StagedOutput extends OutputStatus {
  temporaryPath: string;
  backupPath: string;
  existed: boolean;
  committed: boolean;
  backupCreated: boolean;
}

export async function inspectOutputs(outputs: RenderedOutput[]): Promise<OutputStatus[]> {
  return await Promise.all(
    outputs.map(async (output) => {
      try {
        const existing = await readFile(output.outputPath, "utf8");
        return { ...output, state: existing === output.content ? "current" : "stale" };
      } catch (error) {
        if (isMissing(error)) return { ...output, state: "missing" };
        throw new AgentSnippetError(`Could not read output ${output.outputPath}.`, {
          cause: error instanceof Error ? error : undefined,
        });
      }
    }),
  );
}

export async function writeOutputsAtomically(statuses: OutputStatus[]): Promise<OutputStatus[]> {
  const changed = statuses.filter((status) => status.state !== "current");
  if (changed.length === 0) return statuses;

  const staged: StagedOutput[] = [];
  try {
    for (const output of changed) {
      const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
      const directory = dirname(output.outputPath);
      const temporaryPath = join(directory, `.${basename(output.outputPath)}.${suffix}.tmp`);
      const backupPath = join(directory, `.${basename(output.outputPath)}.${suffix}.bak`);
      let mode = 0o666;
      let existed = false;
      try {
        const metadata = await stat(output.outputPath);
        existed = true;
        mode = metadata.mode;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      await writeFile(temporaryPath, output.content, { encoding: "utf8", flag: "wx", mode });
      if (existed) await chmod(temporaryPath, mode);
      staged.push({
        ...output,
        temporaryPath,
        backupPath,
        existed,
        committed: false,
        backupCreated: false,
      });
    }

    for (const output of staged) {
      if (output.existed) {
        await rename(output.outputPath, output.backupPath);
        output.backupCreated = true;
      }
      await rename(output.temporaryPath, output.outputPath);
      output.committed = true;
    }
  } catch (error) {
    const rollbackFailed = await rollback(staged);
    const detail = rollbackFailed
      ? " Rollback was incomplete; inspect the affected outputs."
      : " Previous outputs were restored.";
    throw new AgentSnippetError(`Could not commit generated outputs.${detail}`, {
      cause: error instanceof Error ? error : undefined,
    });
  }

  await Promise.allSettled(
    staged.flatMap((output) => [
      ...(output.backupCreated ? [removeIfPresent(output.backupPath)] : []),
      removeIfPresent(output.temporaryPath),
    ]),
  );
  return statuses;
}

async function rollback(staged: StagedOutput[]): Promise<boolean> {
  let failed = false;
  for (const output of [...staged].reverse()) {
    if (output.committed) {
      try {
        await removeIfPresent(output.outputPath);
      } catch {
        failed = true;
      }
    }
    if (output.backupCreated) {
      try {
        await rename(output.backupPath, output.outputPath);
      } catch {
        failed = true;
      }
    }
    try {
      await removeIfPresent(output.temporaryPath);
    } catch {
      failed = true;
    }
  }
  return failed;
}

async function removeIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
