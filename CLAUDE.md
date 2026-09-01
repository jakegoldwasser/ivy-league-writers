# Palisade Writers

Static site (plain HTML/CSS/JS, no framework, no build step) for palisadewriters.com.

- Source of truth for the deployed site is `public/` — edit files there directly.
- Deploys to Cloudflare Workers via Assets (not Pages, not Workers Sites).
- Deploy command: `wrangler deploy`
- Config: `wrangler.jsonc` (routes bind palisadewriters.com + www to this Worker)
- Contact form posts to web3forms.com (access key hardcoded in `public/index.html`).

Legacy: this repo's `main` branch also still deploys to **ivyleaguewriters.com**
via GitHub Pages (the root `CNAME` file), which is a separate, older site under
the "Ivy League Writers" brand. Do not assume AWS is involved anywhere here.
