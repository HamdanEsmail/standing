export interface Env {
  DB: D1Database;
  STORE: R2Bucket;
  TINYFISH_API_KEY: string;
  ADMIN_TOKEN: string;
  WEBHOOK_SECRET: string;
  PUBLIC_BASE_URL: string;
  /** "1" turns the site's screens on (src/site); anything else leaves every site path answering as before. */
  SITE_ENABLED?: string;
  /** The public source repository; the About page links it only when this is set. */
  REPO_URL?: string;
  /** "0" turns the stored copies of the site's screens off (src/site/htmlCache.ts); anything else leaves them on. */
  HTML_CACHE?: string;
  /** This Worker version (wrangler.jsonc `version_metadata`): its id stamps the stored screens. */
  CF_VERSION_METADATA?: WorkerVersionMetadata;
}
