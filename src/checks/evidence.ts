// Evidence for a result (spec 4.7): `evidence/<check id>.jpg`, the register page as it was read,
// and for Fetch-method checks also `evidence/<check id>.md`, the markdown that was parsed. Served
// at /evidence/<check id>.jpg|md (src/handlers/objects.ts). Evidence is best effort: a failed
// screenshot never fails a check, it only leaves the result without an image.
import { PRICES } from "../core/spend";
import type { Env } from "../env";
import { downloadStepScreenshot, getRun, pickEvidenceStep, type AgentStep } from "../tinyfish/agent";
import { TinyFishError } from "../tinyfish/client";
import { checkDeps } from "./deps";

export function evidenceKey(checkId: string, extension: "jpg" | "md"): string {
  return `evidence/${checkId}.${extension}`;
}

/** What a screenshot attempt stored and what it cost (TinyBrowser bills once its session exists). */
export interface Shot {
  key: string | null;
  spentUsd: number;
}

/**
 * The Agent run's evidence: the step `pickEvidenceStep` chooses (the last one on the record page),
 * downloaded with the API-key endpoint and stored as `evidence/<checkId>.jpg`. `steps` are the run's
 * steps read with screenshots (the callback has them already); without them the run is read again.
 * Null when no step has a screenshot or the download fails. Costs nothing: the image is part of a
 * step already billed.
 */
export async function storeAgentEvidence(
  env: Env,
  checkId: string,
  runId: string,
  steps?: readonly AgentStep[],
): Promise<string | null> {
  try {
    const list = steps ?? (await getRun(env, runId, "url")).steps;
    const stepId = pickEvidenceStep({ steps: list });
    if (stepId === null) return null;
    const bytes = await downloadStepScreenshot(env, runId, stepId);
    const key = evidenceKey(checkId, "jpg");
    await env.STORE.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
    return key;
  } catch {
    console.error("agent evidence not stored");
    return null;
  }
}

/**
 * A TinyBrowser full-page screenshot of `url` as `evidence/<checkId>.jpg`. `screenshotFullPage`
 * records its own $0.002 spend row; `spentUsd` reports the same amount for the check's own
 * `spend_usd`. A TinyFishError comes from the session request, which is not billed; any later
 * failure happened after the session was created, so it was.
 */
export async function storeScreenshot(env: Env, checkId: string, url: string): Promise<Shot> {
  try {
    const { bytes } = await checkDeps.screenshotFullPage(env, url);
    const key = evidenceKey(checkId, "jpg");
    await env.STORE.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
    return { key, spentUsd: PRICES.screenshot };
  } catch (err) {
    // The reason, shaped and short (a CDP step or timeout; never a key or a webhook secret).
    console.error("screenshot evidence not stored", err instanceof Error ? err.message.replace(/[^\w :.-]/g, " ").slice(0, 100) : "unknown");
    return { key: null, spentUsd: err instanceof TinyFishError ? 0 : PRICES.screenshot };
  }
}

/**
 * Evidence for a Fetch-method result: the markdown read, as `evidence/<checkId>.md`, and a
 * TinyBrowser screenshot of the same URL. `key` is the screenshot's key, or the markdown's when the
 * screenshot failed (either key releases both objects when the check is purged).
 */
export async function storeFetchEvidence(env: Env, checkId: string, url: string, markdown: string): Promise<Shot & { key: string }> {
  const mdKey = evidenceKey(checkId, "md");
  await env.STORE.put(mdKey, markdown, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
  const shot = await storeScreenshot(env, checkId, url);
  return { key: shot.key ?? mdKey, spentUsd: shot.spentUsd };
}
