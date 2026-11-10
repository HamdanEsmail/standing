// The two outside effects the check flow lets tests replace. `vi.mock` does not work in the
// Workers Vitest pool, so tests swap these (vi.spyOn(checkDeps, "screenshotFullPage"), or
// assign `sleep`) instead, as Fineprint does with its captureDeps.
import { screenshotFullPage } from "../tinyfish/browser";

export const checkDeps = {
  /** The TinyBrowser full-page screenshot (records its own $0.002 spend row). */
  screenshotFullPage,
  /** Replaces the 60 s wait between Agent-start retries after a 429; undefined is the real wait. */
  sleep: undefined as undefined | ((ms: number) => Promise<void>),
};
