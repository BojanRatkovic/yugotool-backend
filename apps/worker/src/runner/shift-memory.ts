import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parseShiftTasks, type ShiftTask } from "@yugotool/contracts";

const exec = promisify(execFile);

/** Durable memory of a shift station, inside the run's worktree; never committed. */
export const MEMORY_DIR = ".yugotool";

const memoryPath = (worktreePath: string, file: string): string =>
  path.join(worktreePath, MEMORY_DIR, file);

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

export const shiftMemory = {
  /** Writes goal.md and keeps `.yugotool/` out of git (info/exclude is shared by all worktrees). */
  async prepare(worktreePath: string, goal: string): Promise<void> {
    await mkdir(path.join(worktreePath, MEMORY_DIR), { recursive: true });
    await writeFile(memoryPath(worktreePath, "goal.md"), `${goal}\n`);
    const { stdout } = await exec("git", [
      "-C",
      worktreePath,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "info/exclude",
    ]);
    const excludeFile = stdout.trim();
    const current = (await readOptional(excludeFile)) ?? "";
    if (!current.split("\n").includes(`${MEMORY_DIR}/`)) {
      await mkdir(path.dirname(excludeFile), { recursive: true });
      await appendFile(
        excludeFile,
        `${current && !current.endsWith("\n") ? "\n" : ""}${MEMORY_DIR}/\n`,
      );
    }
  },

  async read(worktreePath: string): Promise<{
    goal: string | null;
    tasks: ShiftTask[];
    progress: string | null;
    learnings: string | null;
  }> {
    const [goal, tasks, progress, learnings] = await Promise.all(
      ["goal.md", "tasks.json", "progress.md", "learnings.md"].map((file) =>
        readOptional(memoryPath(worktreePath, file)),
      ),
    );
    return {
      goal: goal ?? null,
      tasks: parseShiftTasks(tasks ?? null),
      progress: progress ?? null,
      learnings: learnings ?? null,
    };
  },

  async appendProgress(worktreePath: string, entry: string): Promise<void> {
    await appendFile(memoryPath(worktreePath, "progress.md"), `${entry}\n`);
  },

  async appendLearnings(
    worktreePath: string,
    shiftNumber: number,
    gotchas: string[],
  ): Promise<void> {
    if (gotchas.length === 0) return;
    const lines = gotchas.map((g) => `- ${g}`).join("\n");
    await appendFile(
      memoryPath(worktreePath, "learnings.md"),
      `## Shift ${shiftNumber}\n${lines}\n\n`,
    );
  },

  countTasks(tasks: ShiftTask[]): { done: number; total: number } {
    return { done: tasks.filter((t) => t.status === "done").length, total: tasks.length };
  },
};
