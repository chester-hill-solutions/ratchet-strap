# Marketing site

Static, single page, no build step. Open `index.html` directly or serve the directory:

```bash
cd site && python3 -m http.server 8788
```

Deploy the `site/` directory as-is (Cloudflare Pages, GitHub Pages, any static host).
`assets/logo-512.png` and `assets/logo-128.png` are resized copies of
`../assets/ratchet-strap.png`; regenerate them from the original rather than
editing them in place:

```bash
sips -Z 512 ../assets/ratchet-strap.png --out assets/logo-512.png
sips -Z 128 ../assets/ratchet-strap.png --out assets/logo-128.png
```

Copy rules: product claims come from the root `README.md`. If a command, profile
or exit code changes there, change it here in the same pull request.
