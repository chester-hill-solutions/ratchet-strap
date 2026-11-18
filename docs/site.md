# Marketing site

Static, single page, no build step. Source lives in `site/`; it is deployed as a
Cloudflare Worker with static assets to **https://ratchetstrap.chsolutions.ca/**.

## Local preview

```bash
cd site && python3 -m http.server 8788
```

## Deploy

From the repository root:

```bash
bun run deploy   # cf deploy
```

`cloudflare.config.ts` names the Worker (`ratchetstrap`), its custom domain and
its 404 handling; `wrangler.config.ts` points the asset directory at `./site`.
`cf` builds through Wrangler internally, so `wrangler` and `cf` are dev
dependencies — no `wrangler` command is invoked by hand or from a script.

`_headers` carries the security headers (CSP, HSTS, nosniff, frame and
referrer policy) and the cache policy for `/assets/*`. It is consumed by the
platform, not served.

## Conventions adopted from CHS

- **SEO** follows `@chester-hill-solutions/seo`: canonical, Open Graph and
  Twitter tags, `sitemap.xml`, `robots.txt`, JSON-LD as a single `@graph`
  (Organization → WebSite → SoftwareApplication), and a short `llms.txt` that
  links to what an agent should read rather than restating the page.
- **Analytics** is CHS first-party: `https://stats.chesterhillsolutions.ca/b.js`
  with `data-site="ratchetstrap.chsolutions.ca"`. The site must exist in the
  collector's `sites` table, and requests must survive the CSP `script-src` and
  `connect-src` allowlists.
- **Headers** follow `@chester-hill-solutions/security-headers`, hand-written
  because the site is static.

## Rules

Profiles and the twelve golden defaults are not repeated on the page; the
quickstart links to their README anchors. A public page states a condition
whenever a guarantee has one — "cannot be raised" only holds with
`--previous-baseline` or full history in CI, and the page says so.

Product claims come from the root `README.md`. If a command, profile or exit
code changes there, change it here in the same pull request. The `U1`-`U12` list
is copied verbatim from `src/golden/` and must not be paraphrased. Bump
`softwareVersion` in the JSON-LD and the footer when the package version
changes.

`assets/logo-512.png` and `assets/logo-128.png` are resized copies of
`../assets/ratchet-strap.png`; regenerate them from the original rather than
editing them in place:

```bash
sips -Z 512 ../assets/ratchet-strap.png --out assets/logo-512.png
sips -Z 128 ../assets/ratchet-strap.png --out assets/logo-128.png
```

`assets/og.png` (1200×630) is rendered from the site's own type and logo.
