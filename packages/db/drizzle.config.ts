import { defineConfig } from "drizzle-kit";

// drizzle-kit is a CLI with no injection point besides this file, so the env
// read lives here (with a local-dev default) as the one exception to
// "env is parsed only in app config".
export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env["DATABASE_URL"] ?? "postgres://localhost:5432/zastava",
  },
});
