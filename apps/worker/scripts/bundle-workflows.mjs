#!/usr/bin/env node
/**
 * Prebuilds the workflow bundle (`node scripts/bundle-workflows.mjs <out.js>`)
 * so a packaged worker starts without running webpack. Needs `pnpm build`.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { bundleWorkflowCode } from "@temporalio/worker";

const out = process.argv[2];
if (!out) throw new Error("usage: bundle-workflows.mjs <out.js>");
const workflowsPath = path.resolve(import.meta.dirname, "..", "dist", "workflows", "index.js");
const { code } = await bundleWorkflowCode({ workflowsPath, logger: undefined });
writeFileSync(out, code);
console.log(`workflow bundle: ${(code.length / 1024).toFixed(0)} KB → ${out}`);
