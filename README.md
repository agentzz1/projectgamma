# Karlsruhe Walk

Desktop-first browser prototype for freely walking through a Karlsruhe-inspired inner city core.

## What it does

- Uses CesiumJS in the browser from the local repo.
- Runs free and local for development, with no external API keys or cloud accounts.
- Uses a local OSM-derived block model and curated walk mesh.
- Keeps movement on a curated walk mesh so the player stays on streets and plazas.

## Runtime config

`server.js` still exposes `/runtime-config.js`, but it only carries local metadata.
No external API keys or tokens are required for normal use.

## Local usage

```powershell
npm install
npm start
```

Open `http://localhost:3000`.

Controls:

- `W A S D`: move
- `ArrowUp` / `ArrowDown`: forward / back
- `ArrowLeft` / `ArrowRight`: turn
- `Space` or `Shift`: sprint
- `M`: map
- `E`: inspect nearby landmark
- `F`: fullscreen
- `Enter`: start from overlay or reset to Schlossplatz

## Build for static hosting

```powershell
npm run build
```

This writes a deployable `dist/` directory including local Cesium assets, a generated `runtime-config.js`, and a `.nojekyll` marker for GitHub Pages.
The generated config does not require any secrets.

## GitHub Pages deploy

The site is meant to be published from the static `dist/` output.

```powershell
npm run build
```

Then publish `dist/` to GitHub Pages, for example with a `gh-pages` branch or a Pages workflow.
The app uses relative asset paths, so it works both locally and on GitHub Pages project sites.

## Test loop

The web game validation script used during development is:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run_web_game_test.ps1
```

Artifacts are written to `output/web-game/`.
