import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// SWC instead of esbuild: Nest DI and nestjs-zod DTOs need decorator metadata (e2e tests).
export default defineConfig({
  plugins: [swc.vite({ module: { type: "es6" } })],
  // Repository tests (`test/db`) run on a real, freshly migrated `zastava_test`.
  test: { globalSetup: ["./test/db/global-setup.ts"] },
});
