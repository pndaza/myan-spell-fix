import { defineConfig } from "vitest/config";

// Tests are pure-logic (diff, chunking, worker handlers with a mocked AI
// binding) and must NOT pick up the Cloudflare vite plugin — that plugin is
// for building/running the full-stack app, not for the unit-test pipeline.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "worker/**/*.test.ts"],
  },
});
