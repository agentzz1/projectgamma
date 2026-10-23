# Karlsruhe Walk

Desktop-first browser game for freely walking through the real inner city of Karlsruhe in first person.

## What it does

- Uses CesiumJS in the browser from the local repo.
- Renders the real buildings of the inner city (Schlossgarten to Ettlinger Tor, Europaplatz to Durlacher Tor) from OpenStreetMap: real footprints, heights, roof shapes (gabled, hipped, skillion, pyramidal, dome) and mapped facade and roof colours.
- Places real trees, street lamps and benches at their mapped positions.
- Uses the free LGL Baden-Württemberg DOP20 aerial imagery as ground. If that service is unreachable, it falls back to a local ground with parks, water and squares from OpenStreetMap.
- Lets you walk anywhere outside buildings; the HUD shows the real street or square you are on.
- Runs free, with no API keys or cloud accounts.

## Data

All city data lives in `public/data/osm-city.json` and is generated once from the OpenStreetMap API:

```powershell
npm run fetch-osm
```

`scripts/fetch-osm.mjs` downloads the area in small tiles (cached in your temp directory), assembles buildings, building parts and multipolygons, derives heights from `height` / `building:levels`, and writes the file in the game's local metre coordinates.
Landmark texts, positions and travel viewpoints are curated in `public/data/landmarks.json`.

Buildings, trees and streets: © OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright). Aerial imagery: LGL Baden-Württemberg.

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
- `Q` / `Z`: look up / down
- `Space` or `Shift`: sprint
- `M`: map
- `E`: inspect nearby landmark
- `L`: travel to a landmark
- `R`: toggle rain
- `P`: save a photo
- `F`: fullscreen
- `Enter`: start from overlay or reset to Schlossplatz

Shadows are on in desktop browsers and switch off automatically if the frame rate stays below 24 fps.

## Build for static hosting

```powershell
npm run build
```

This writes a deployable `dist/` directory including local Cesium assets, a generated `runtime-config.js`, and a `.nojekyll` marker for GitHub Pages.
The generated config does not require any secrets.

## GitHub Pages deploy

The site is meant to be published from the static `dist/` output.
Live URL: `https://agentzz1.github.io/projectgamma/`

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
