#!/usr/bin/env node
// A fake `claude` for spec 0016 tests. Auth state lives in `<config dir>/stub-auth.json`.
// Like the real CLI, CLAUDE_CONFIG_DIR set explicitly to ~/.claude reads another
// keychain item, so it reports signed out there.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const home = process.env.HOME;
const explicit = process.env.CLAUDE_CONFIG_DIR;
const dir = explicit ?? path.join(home, ".claude");
const file = path.join(dir, "stub-auth.json");
const signedIn = existsSync(file) && explicit !== path.join(home, ".claude");
const [cmd, sub] = process.argv.slice(2);

if (cmd === "auth" && sub === "status") {
  const auth = signedIn ? JSON.parse(readFileSync(file, "utf8")) : {};
  console.log(JSON.stringify({ loggedIn: signedIn, configDirectory: dir, ...auth }, null, 2));
  process.exit(signedIn ? 0 : 1);
} else if (cmd === "auth" && sub === "logout") {
  rmSync(file, { force: true });
} else if (cmd === "auth" && sub === "login") {
  const url = "https://claude.com/cai/oauth/authorize?code=true&state=stub";
  process.stdout.write("Opening browser to sign in…\n");
  process.stdout.write(
    `If the browser didn't open, visit: \u001b]8;;${url}\u0007${url}\u001b]8;;\u0007\nPaste code here if prompted > `,
  );
  createInterface({ input: process.stdin }).on("line", (code) => {
    if (code.trim() !== "good") {
      process.stderr.write("Login failed: Request failed with status code 400\n");
      process.exit(1);
    }
    const email = process.argv.includes("--email")
      ? process.argv[process.argv.indexOf("--email") + 1]
      : "new@example.com";
    writeFileSync(file, JSON.stringify({ email, orgName: null, subscriptionType: "max" }));
    process.exit(0);
  });
} else {
  process.exit(2);
}
