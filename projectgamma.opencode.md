# projectgamma OpenCode instructions

- This repo is a browser-based first-person Karlsruhe walking prototype.
- Hard constraint: keep it 100% free and local. No external API keys, paid cloud tiles, or hidden service dependencies.
- Prefer the local OSM-derived block model and curated walk mesh.
- Primary files of interest are `public/game.js`, `public/index.html`, `server.js`, and `scripts/build.mjs`.
- Keep `window.render_game_to_text()` and `window.advanceTime(ms)` intact because the test loop depends on them.
- After meaningful changes, update `progress.md` and run the web-game test loop before handing work back.
