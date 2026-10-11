/** Server to create the test database on; override for a non-default local Postgres. */
export const ADMIN_URL =
  process.env["TEST_DATABASE_ADMIN_URL"] ?? "postgres://localhost:5432/postgres";
export const TEST_DB = "yugotool_test";

/** The database global-setup recreated and migrated for this run. */
export function testDatabaseUrl(): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${TEST_DB}`;
  return url.toString();
}
