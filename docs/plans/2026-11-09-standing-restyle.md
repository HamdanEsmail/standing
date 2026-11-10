# Standing: restyle to the "Verdict" look

Standing got a new look on 9 Nov 2026, so that it has a look of its own. This plan restyles the finished site. It changes how pages look, not what they do. In the repository it lives at `docs/plans/2026-11-09-standing-restyle.md`.

**The look:** `../family/standing/DESIGN-v2.md` (copy to the repository root as `DESIGN.md`, replacing the old one) and the approved home `../family/standing/comp-home-v2.html` with `comp-home-v2.png` (copy both to `design/`, replacing the old comp; `comp-assets/` stays). Read DESIGN-v2.md fully before touching any file.

## Rules

- **Behaviour is frozen.** No change to routes, data, the JSON API, honest-state copy, limits, or anything under `src/` outside `src/site/`. The core is not touched.
- **Keep the contracts the tests pin:** the class names for status (`status-word <status>`, `chip ok|warn|bad|neutral`), form field names, links, meta tags and every honest-state string. Add modifier classes freely. If a test fails, the restyle broke a contract: fix the restyle, not the test. Change a test only where it asserts something this plan deliberately changes (the stamp, uppercase label text), and say so in the note.
- **Where the work goes:** `public/assets/tokens.css` (rewritten from DESIGN-v2.md), `public/assets/site.css`, `public/assets/fonts/` (Bricolage Grotesque, Geist, Geist Mono as self-hosted woff2; remove the IBM Plex files), `src/site/layout.tsx`, `src/site/components.tsx`, and view files only for markup the new look needs.
- **Status words are sentence case in the markup** ("Active", "Not licensed"). The status colour mapping is in DESIGN-v2.md.
- **No script.** The grain is a CSS background with a data URI, which the existing content-security-policy allows (`img-src 'self' data:`). No inline `<style>` blocks beyond what the policy already permits.
- **Phone first is checked for real:** every screen at a 375px viewport and at 1280. No sideways scroll.
- **Targeted testing.** Run only the site test files while working, the full `npm run check` once per step before its commit. No new tests unless a markup contract changes.
- **Build directly, one commit per step, each ending with a note and a preview address** (`wrangler versions upload --var SITE_ENABLED:1`). The site stays off in production until the final preview has been looked at.
- **No TinyFish spend** is needed for any of this. Do not start live checks; use the stored results and the permanent examples.

## Step R1: foundations and the home (ends with a look at the preview)

- [x] New `DESIGN.md`, new tokens, the three fonts, the grain, the wordmark with its status light, the pill navigation, buttons, inputs, the footer.
- [x] The home rebuilt to match `comp-home-v2.html` section by section: the opening with the form slab and the verdict slab holding the real curated record, the figures row, the "Ambiguous" band with real candidate rows, the three numbered steps, the status changes (the honest empty line when there are none), the register index, the bounty proof block and the spend line restyled as rows.
- [x] Look at it at 375 and 1280. Commit `site: the Verdict look, foundations and home`. Upload a preview. **Stop and look.**

## Step R2: the result, the receipt and the record (ends with a look at the preview)

- [x] The verdict slab on `/checks/:id` for every outcome and for pending ("Checking" with the pulsing dot), with the actions in the slab's foot; facts and the evidence panel below.
- [x] The receipt as one white sheet with its coloured top strip; check its print preview on one A4 sheet with backgrounds on and off.
- [x] The record page with its watch line and change rows.
- [x] Commit `site: the Verdict look on results, receipt and records`. Preview addresses for: a match, the ambiguous example, the no-match example, a receipt, a watched record. **Stop and look.**

## Step R3: the rest, and the final preview (ends with a look at the final preview)

- [x] Watchlist, Coverage, API, About and the not-found page.
- [x] A new `social.png` (1200x630) from the verdict slab.
- [x] One pass over every screen against DESIGN-v2.md's "Never" list and its phone sizes; fix what it finds.
- [x] Commit `site: the Verdict look on every page`. Send the final preview address. **Stop: look at it before switch-on.**

After that the site plan continues where it stopped: Task 7 (switch on after the final look, then the CPU measurement) and Task 8 (README, submission sheet, posts, demo script, and the clean-up before the repository goes public).
