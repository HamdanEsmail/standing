// GET /evidence/<check id>.jpg|md: the evidence a check stored in R2 (src/checks/evidence.ts).
// An object is written once per check and never changes, so it is cached for a year. The markdown
// is a third party's page text: it is served sandboxed and never sniffed into another type.
import { Hono } from "hono";
import type { Env } from "../env";

export const objectsRouter = new Hono<{ Bindings: Env }>();

const CACHE_FOREVER = "public, max-age=31536000, immutable";
// A check id (a lowercase UUID) and one of the two evidence extensions, nothing else: the name
// becomes part of an R2 key.
const NAME = /^[0-9a-f-]{36}\.(jpg|md)$/;
const FALLBACK_TYPE = { jpg: "image/jpeg", md: "text/markdown; charset=utf-8" } as const;

objectsRouter.get("/evidence/:key", async (c) => {
  const key = c.req.param("key");
  const m = NAME.exec(key);
  if (!m) return c.json({ error: "not_found" }, 404);
  const object = await c.env.STORE.get(`evidence/${key}`);
  if (object === null) return c.json({ error: "not_found" }, 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  if (!headers.has("content-type")) headers.set("content-type", FALLBACK_TYPE[m[1] as "jpg" | "md"]);
  headers.set("cache-control", CACHE_FOREVER);
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", "sandbox");
  headers.set("etag", object.httpEtag);
  return new Response(object.body, { headers });
});
