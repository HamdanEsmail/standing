import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// This file runs in Node. The project has no @types/node, so the little of Node it
// needs (the environment and one file read) is typed here.
const { process } = globalThis as unknown as {
  process: {
    env: Record<string, string | undefined>;
    getBuiltinModule(id: "node:fs"): { readFileSync(path: string, encoding: "utf8"): string };
  };
};

// The opt-in live test (tests/integration/gmc.live.test.ts) needs the real TinyFish key. It is
// handed over as LIVE_TINYFISH_API_KEY, and only when the shell sets STANDING_LIVE=1, so
// `npm run check` never spends money. The key comes from .dev.vars (the file wrangler dev and the
// spikes use), else from TINYFISH_API_KEY in the shell: an old key left in the shell environment
// must not override the project's key. It is never printed, and it never replaces the fixed
// TINYFISH_API_KEY binding below.
function liveKey(): string | undefined {
  if (process.env.STANDING_LIVE !== "1") return undefined;
  try {
    const text = process.getBuiltinModule("node:fs").readFileSync(".dev.vars", "utf8");
    for (const line of text.split(/\r?\n/)) {
      const i = line.indexOf("=");
      if (i > 0 && line.slice(0, i).trim() === "TINYFISH_API_KEY" && line.slice(i + 1).trim() !== "") {
        return line.slice(i + 1).trim();
      }
    }
  } catch {
    // no .dev.vars: fall back to the shell
  }
  return process.env.TINYFISH_API_KEY || undefined;
}

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const live = liveKey();
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            // Fixed test values. They win over anything in .dev.vars, so unit
            // tests never see the real TinyFish key.
            TINYFISH_API_KEY: "test-tinyfish-key",
            ADMIN_TOKEN: "test-admin",
            WEBHOOK_SECRET: "test-secret",
            PUBLIC_BASE_URL: "https://standing.test",
            // The site is on in tests; tests/site-shell.test.ts also checks it switched off.
            SITE_ENABLED: "1",
            // No source link in tests; tests/site-pages.test.ts sets one for a single request.
            REPO_URL: "",
            // Stored screen copies are off for the suites that change data and read a screen again;
            // tests/site-cache.test.ts turns them on per request.
            HTML_CACHE: "0",
            TEST_MIGRATIONS: await readD1Migrations("./migrations"),
            ...(live ? { LIVE_TINYFISH_API_KEY: live } : {}),
            // Who a live test looks up is given in the shell, so no test file names a person:
            // STANDING_LIVE_GMC_NAME, STANDING_LIVE_NMC_PIN, STANDING_LIVE_SRA_NUMBER.
            ...(live && process.env.STANDING_LIVE_GMC_NAME ? { LIVE_GMC_NAME: process.env.STANDING_LIVE_GMC_NAME } : {}),
            ...(live && process.env.STANDING_LIVE_NMC_PIN ? { LIVE_NMC_PIN: process.env.STANDING_LIVE_NMC_PIN } : {}),
            ...(live && process.env.STANDING_LIVE_SRA_NUMBER ? { LIVE_SRA_NUMBER: process.env.STANDING_LIVE_SRA_NUMBER } : {}),
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./tests/setup.ts"],
  },
});
