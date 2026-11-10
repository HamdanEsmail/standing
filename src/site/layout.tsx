// The document every screen shares: head (title, description, styles, the two preloaded fonts), the
// header (wordmark with its status light, the pill navigation) and the footer (the spend meter). No inline script or style
// element: the CSP allows only files from this origin, and every screen works without JavaScript.
import type { Child } from "hono/jsx";
import { createContext, useContext } from "hono/jsx";
import { raw } from "hono/html";
import type { Stats } from "../handlers/stats";
import { money, plural, SPEND_PAUSED_LINE } from "./format";

/** What every page needs from the request: the site's own address (PUBLIC_BASE_URL) and the page's path,
 *  for the link-preview tags, which must be absolute. Set by the router's render. */
export const PageContext = createContext<{ base: string; path: string }>({ base: "", path: "/" });

/** The link-preview card: a real record card at 1200 by 630. */
const SOCIAL_IMAGE = "/assets/social.png";

export type NavKey = "check" | "watchlist" | "coverage" | "api" | "about";

const NAV: { key: NavKey; href: string; text: string }[] = [
  { key: "check", href: "/", text: "Check" },
  { key: "watchlist", href: "/watchlist", text: "Watchlist" },
  { key: "coverage", href: "/coverage", text: "Coverage" },
  { key: "api", href: "/api", text: "API" },
  { key: "about", href: "/about", text: "About" },
];

/** The footer's spend meter: "TinyFish spend $1.48 · 24 checks · $0.06 per check". */
export function spendMeter(s: Stats): string {
  const parts = [`TinyFish spend ${money(s.spend_usd)}`, plural(s.checks, "check")];
  if (s.cost_per_check > 0) parts.push(`${money(s.cost_per_check)} per fresh check`);
  return parts.join(" · ");
}

/**
 * A full page. `stats` is null on the 404 and error pages, which render without the database: the
 * spend meter is left out there. `paused` is the checks' own spend-pause answer (spendPaused), never
 * worked out here. `refresh` reloads the page by itself (a pending check), as a meta tag, so it works
 * with JavaScript off. `noindex` keeps a screen out of search engines (a check result is a visitor's).
 */
export function Layout(props: {
  title: string;
  description: string;
  active: NavKey | null;
  stats: Stats | null;
  paused?: boolean;
  refresh?: string;
  noindex?: boolean;
  bodyClass?: string;
  children: Child;
}) {
  const { stats } = props;
  const page = useContext(PageContext);
  return (
    <>
      {raw("<!doctype html>")}
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          {props.refresh ? <meta http-equiv="refresh" content={props.refresh} /> : null}
          {props.noindex ? <meta name="robots" content="noindex" /> : null}
          <title>{props.title}</title>
          <meta name="description" content={props.description} />
          <meta name="author" content="Hamdan Esmail" />
          <meta name="theme-color" content="#edf0ed" />
          <meta property="og:type" content="website" />
          <meta property="og:site_name" content="Standing" />
          <meta property="og:title" content={props.title} />
          <meta property="og:description" content={props.description} />
          <meta property="og:url" content={page.base + page.path} />
          <meta property="og:image" content={page.base + SOCIAL_IMAGE} />
          <meta property="og:image:width" content="1200" />
          <meta property="og:image:height" content="630" />
          <meta property="og:image:alt" content="A Standing record card: the status word, the register's own wording, and the register page it was read from." />
          <meta name="twitter:card" content="summary_large_image" />
          <meta name="twitter:image" content={page.base + SOCIAL_IMAGE} />
          <link rel="preload" href="/assets/fonts/bricolage-grotesque-latin-opsz-normal.woff2" as="font" type="font/woff2" crossorigin="anonymous" />
          <link rel="preload" href="/assets/fonts/geist-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin="anonymous" />
          <link rel="stylesheet" href="/assets/tokens.css" />
          <link rel="stylesheet" href="/assets/site.css" />
          <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        </head>
        <body class={props.bodyClass}>
          <a class="skip" href="#main">
            Skip to the content
          </a>
          {props.paused ? (
            <p class="notice" role="status">
              <span class="wrap">{SPEND_PAUSED_LINE}</span>
            </p>
          ) : null}
          <header class="top">
            <div class="wrap">
              <a class="wordmark" href="/">
                <i class="light" aria-hidden="true"></i>Standing
              </a>
              <nav class="pill" aria-label="Main">
                {NAV.map((item) => (
                  <a href={item.href} class={props.active === item.key ? "on" : undefined} aria-current={props.active === item.key ? "page" : undefined}>
                    {item.text}
                  </a>
                ))}
              </nav>
            </div>
          </header>
          <main id="main" class="wrap">
            {props.children}
          </main>
          <footer>
            <div class="wrap">
              {stats ? (
                <p class="meter">
                  TinyFish spend <span class="num">{money(stats.spend_usd)}</span> · <span class="num">{stats.checks}</span> {stats.checks === 1 ? "check" : "checks"}
                  {stats.cost_per_check > 0 ? (
                    <>
                      {" "}
                      · <span class="num">{money(stats.cost_per_check)}</span> per fresh check
                    </>
                  ) : null}
                </p>
              ) : null}
              <p>
                Standing reads official registers with the TinyFish APIs. <a href="/api/registries">Coverage as JSON</a> ·{" "}
                <a href="/api/stats">Figures as JSON</a>
              </p>
              <p>
                Built by{" "}
                <a href="https://github.com/HamdanEsmail" rel="author">
                  Hamdan Esmail
                </a>
              </p>
            </div>
          </footer>
        </body>
      </html>
    </>
  );
}
