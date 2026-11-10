// TinyBrowser: a full-page screenshot over raw Chrome DevTools Protocol, from inside
// a Worker. A straight port of the verified spike (spikes/worker-shot/src/index.js):
// no Playwright, no Node APIs.
import { SCREENSHOT_MAX_HEIGHT } from "../core/limits";
import { PRICES } from "../core/spend";
import type { Env } from "../env";
import { tinyfishFetch } from "./client";

const BROWSER_API = "https://api.browser.tinyfish.ai";
const COMMAND_TIMEOUT_MS = 45_000;
/** Time for the page to finish loading and painting before it is measured. */
const SETTLE_MS = 6_000;
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 800;

/** Time for a declined cookie banner to go away (some pages reload) before the next step. */
const CONSENT_SETTLE_MS = 2_500;

/**
 * The labels of a plain cookie banner's "no" button and of the "hide this message" button some registers
 * show after it. Only these are ever clicked, and only inside an element whose id, class or label names
 * cookies or consent: anything else on the page (a robot check, a login, a pop-up of another kind) is
 * left as it is and photographed as it is.
 */
export const DECLINE_LABEL =
  /^(?:(?:reject|decline)(?: all)?(?: additional| analytics| optional| non-essential)?(?: cookies)?|(?:use|accept) (?:only )?(?:necessary|essential) cookies(?: only)?|necessary cookies only)$/i;
export const HIDE_LABEL = /^hide (?:this|the|cookie) message$/i;

/** True when `label` is a button a plain consent banner uses to decline, or to hide its confirmation. */
export function isConsentButton(label: string, step: "decline" | "hide"): boolean {
  const text = label.replace(/\s+/g, " ").trim();
  return (step === "decline" ? DECLINE_LABEL : HIDE_LABEL).test(text);
}

/** The script run in the page: clicks the first matching button inside a cookie or consent banner and
 *  returns its label, or "" when there is none. */
export function consentScript(pattern: RegExp): string {
  return `(() => {
  const label = ${pattern.toString()};
  const inBanner = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const s = ((n.id || "") + " " + (typeof n.className === "string" ? n.className : "") + " " + ((n.getAttribute && n.getAttribute("aria-label")) || "")).toLowerCase();
      if (s.includes("cookie") || s.includes("consent")) return true;
    }
    return false;
  };
  for (const b of document.querySelectorAll("button, a, input[type=button], input[type=submit]")) {
    const t = ((b.innerText || b.value || "") + "").replace(/\\s+/g, " ").trim();
    if (label.test(t) && inBanner(b)) { b.click(); return t; }
  }
  return "";
})()`;
}

type CdpReply = { id?: number; result?: unknown; error?: unknown };
type Pending = { resolve: (result: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> };

export async function screenshotFullPage(
  env: Env,
  url: string,
): Promise<{ bytes: ArrayBuffer; height: number; sessionId: string }> {
  // Session creation is the billed step, so it records the spend row (one browser-minute).
  const created = await tinyfishFetch(env, BROWSER_API, {
    method: "POST",
    body: JSON.stringify({ url }),
    spend: { kind: "screenshot", amountUsd: PRICES.screenshot, ref: url },
  });
  const session = (await created.json()) as { session_id?: unknown; cdp_url?: unknown };
  if (typeof session.cdp_url !== "string" || session.cdp_url === "") {
    throw new Error("TinyBrowser returned no cdp_url");
  }
  const sessionId = typeof session.session_id === "string" ? session.session_id : "";

  // The CDP socket lives on the session's own host and needs no API key.
  const upgrade = await fetch(session.cdp_url.replace(/^ws/, "http"), { headers: { Upgrade: "websocket" } });
  const ws = upgrade.webSocket;
  if (!ws) throw new Error(`TinyBrowser did not upgrade to a websocket (HTTP ${upgrade.status})`);
  ws.accept();

  let nextId = 0;
  const pending = new Map<number, Pending>();
  const failAll = (reason: string) => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      pending.delete(id);
    }
  };
  ws.addEventListener("message", (m) => {
    let reply: CdpReply;
    try {
      reply = JSON.parse(String(m.data)) as CdpReply;
    } catch {
      return;
    }
    if (typeof reply.id !== "number") return;
    const p = pending.get(reply.id);
    if (!p) return;
    pending.delete(reply.id);
    clearTimeout(p.timer);
    if (reply.error) p.reject(new Error(`CDP error: ${JSON.stringify(reply.error)}`));
    else p.resolve(reply.result);
  });
  ws.addEventListener("close", () => failAll("TinyBrowser closed the connection"));
  ws.addEventListener("error", () => failAll("TinyBrowser connection error"));

  const send = <T>(method: string, params: Record<string, unknown> = {}, cdpSessionId?: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`CDP timeout: ${method}`));
      }, COMMAND_TIMEOUT_MS);
      pending.set(id, { resolve: resolve as (r: unknown) => void, reject, timer });
      try {
        ws.send(JSON.stringify({ id, method, params, ...(cdpSessionId ? { sessionId: cdpSessionId } : {}) }));
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

  try {
    const { targetInfos } = await send<{ targetInfos: { type: string; targetId: string }[] }>("Target.getTargets");
    let targetId = targetInfos.find((t) => t.type === "page")?.targetId;
    if (!targetId) {
      targetId = (await send<{ targetId: string }>("Target.createTarget", { url: "about:blank" })).targetId;
    }
    const { sessionId: cdpSession } = await send<{ sessionId: string }>("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    await send("Page.enable", {}, cdpSession);
    await send(
      "Emulation.setDeviceMetricsOverride",
      { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1, mobile: false },
      cdpSession,
    );
    await send("Page.navigate", { url }, cdpSession);
    await new Promise<void>((resolve) => setTimeout(resolve, SETTLE_MS));
    // A plain cookie banner is declined, and its confirmation hidden, so the evidence shows the register's
    // page. Best effort: a page without one, or a failed click, is photographed as it is.
    for (const step of [DECLINE_LABEL, HIDE_LABEL]) {
      try {
        const clicked = await send<{ result?: { value?: unknown } }>("Runtime.evaluate", { expression: consentScript(step), returnByValue: true }, cdpSession);
        if (typeof clicked.result?.value === "string" && clicked.result.value !== "") {
          await new Promise<void>((resolve) => setTimeout(resolve, CONSENT_SETTLE_MS));
        }
      } catch {
        // leave the page as it is
      }
    }
    const metrics = await send<{ cssContentSize?: { height?: number }; contentSize?: { height?: number } }>(
      "Page.getLayoutMetrics",
      {},
      cdpSession,
    );
    const height = Math.min(
      Math.ceil(metrics.cssContentSize?.height || metrics.contentSize?.height || VIEWPORT_HEIGHT),
      SCREENSHOT_MAX_HEIGHT,
    );
    const shot = await send<{ data: string }>(
      "Page.captureScreenshot",
      {
        format: "jpeg",
        quality: 80,
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: VIEWPORT_WIDTH, height, scale: 1 },
      },
      cdpSession,
    );
    // Decoding through fetch keeps CPU time tiny; a JS loop over ~1 MB of base64 would not.
    const bytes = await (await fetch(`data:image/jpeg;base64,${shot.data}`)).arrayBuffer();
    return { bytes, height, sessionId };
  } finally {
    // Always close the browser so billing stops, then the socket.
    try {
      await send("Browser.close");
    } catch {
      // The browser may already be gone, or the socket closed first.
    }
    try {
      ws.close();
    } catch {
      // already closed
    }
  }
}
