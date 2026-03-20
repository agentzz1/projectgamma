$outputDir = Join-Path $PSScriptRoot "..\\output\\web-game"

Remove-Item $outputDir -Recurse -Force -ErrorAction SilentlyContinue

node "C:\Users\maogo\.codex\skills\develop-web-game\scripts\web_game_playwright_client.js" `
  --url "http://localhost:3000" `
  --actions-file "tests\playwright-actions.json" `
  --click-selector "#start-btn" `
  --iterations 3 `
  --pause-ms 350 `
  --screenshot-dir "output\web-game"
