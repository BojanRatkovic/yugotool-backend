import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "pg";
import { z } from "zod";

/**
 * The app was called ZASTAVA until 2026-10-11. Its data in ~/.zastava and its
 * Postgres role and database `zastava` move to the new names once, on the
 * first start of YugoTool.
 */
export const LEGACY_NAME = "zastava";

/**
 * Moves ~/.zastava to `home` (~/.yugotool), unless that already has a
 * database, and leaves a symlink behind: the
 * database, git worktrees and Claude account logins hold absolute paths under
 * the old folder (a login's keychain entry is keyed by its path). Returns the
 * old folder when it moved, null when there was nothing to move. Refuses while
 * the old app still runs from it.
 */
export function moveLegacyHome(home: string, userHome = os.homedir()): string | null {
  const legacy = path.join(userHome, `.${LEGACY_NAME}`);
  if (path.resolve(home) !== path.join(userHome, ".yugotool")) return null;
  // A home without a database holds no data yet (a test or a tool made a folder in it).
  if (existsSync(path.join(home, "pg", "PG_VERSION")) || !isRealDir(legacy)) return null;
  const pid = runningPid(path.join(legacy, "supervisor.json"));
  if (pid !== null) {
    throw new Error(
      `ZASTAVA (the old app) is still running (pid ${pid}); quit it so its data can move to ${home}`,
    );
  }
  if (existsSync(home)) {
    // Entry by entry; the old data wins over what the empty home held.
    for (const entry of readdirSync(legacy)) {
      rmSync(path.join(home, entry), { recursive: true, force: true });
      renameSync(path.join(legacy, entry), path.join(home, entry));
    }
    rmdirSync(legacy);
  } else {
    renameSync(legacy, home);
  }
  symlinkSync(home, legacy);
  return legacy;
}

function isRealDir(dir: string): boolean {
  try {
    const stat = lstatSync(dir);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function runningPid(stateFile: string): number | null {
  try {
    const parsed = z
      .object({ pid: z.number() })
      .safeParse(JSON.parse(readFileSync(stateFile, "utf8")));
    if (!parsed.success) return null;
    const { pid } = parsed.data;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/**
 * A cluster made by ZASTAVA has the superuser `zastava` and the database
 * `zastava`. Renames both to `user`/`database` and sets the new password.
 * Postgres can't rename the role a session runs as, so a throwaway superuser
 * does it. Returns false when the cluster isn't a legacy one.
 */
export async function renameLegacyRole(
  connect: (user: string, password: string, database: string) => Client,
  names: { user: string; password: string; database: string },
): Promise<boolean> {
  const legacy = connect(LEGACY_NAME, LEGACY_NAME, "postgres");
  try {
    await legacy.connect();
  } catch {
    await legacy.end().catch(() => undefined);
    return false;
  }
  const helper = `${names.user}_rename`;
  const helperPassword = `${names.password}-${process.pid}`;
  try {
    await legacy.query(`drop role if exists ${helper}`);
    await legacy.query(`create role ${helper} superuser login password '${helperPassword}'`);
  } finally {
    await legacy.end();
  }
  const admin = connect(helper, helperPassword, "postgres");
  await admin.connect();
  try {
    await admin.query(`alter role ${LEGACY_NAME} rename to ${names.user}`);
    await admin.query(`alter role ${names.user} password '${names.password}'`);
    const { rowCount } = await admin.query(`select 1 from pg_database where datname = $1`, [
      LEGACY_NAME,
    ]);
    if (rowCount) await admin.query(`alter database ${LEGACY_NAME} rename to ${names.database}`);
  } finally {
    await admin.end();
  }
  const owner = connect(names.user, names.password, "postgres");
  await owner.connect();
  try {
    await owner.query(`drop role ${helper}`);
  } finally {
    await owner.end();
  }
  return true;
}
