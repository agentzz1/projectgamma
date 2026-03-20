const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 3000;
const DIST_DIR = path.join(__dirname, "dist");
const PUBLIC_DIR = path.join(__dirname, "public");
const CESIUM_DIR = path.join(__dirname, "node_modules", "cesium", "Build", "Cesium");
const SERVE_DIST = process.argv.includes("--dist") || process.env.SERVE_DIST === "1";
const STATIC_DIR = SERVE_DIST && fs.existsSync(DIST_DIR) ? DIST_DIR : PUBLIC_DIR;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

function send(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "credentialless",
    ...headers,
  });
  res.end(body);
}

function resolveFile(rootDir, urlPath) {
  const cleanPath = decodeURIComponent((urlPath || "/").split("?")[0]);
  const relativePath = cleanPath === "/" ? "index.html" : cleanPath.replace(/^\/+/, "");
  const absolutePath = path.normalize(path.join(rootDir, relativePath));

  if (!absolutePath.startsWith(rootDir)) {
    return null;
  }

  return absolutePath;
}

function makeRuntimeConfig() {
  const payload = {
    freeOnly: true,
    qualityMode: "local",
  };

  return `window.__KARLSRUHE_WALK_CONFIG__ = ${JSON.stringify(payload, null, 2)};\n`;
}

const server = http.createServer((req, res) => {
  const requestPath = decodeURIComponent((req.url || "/").split("?")[0]);

  if (requestPath === "/runtime-config.js") {
    send(res, 200, makeRuntimeConfig(), {
      "Content-Type": "application/javascript; charset=utf-8",
    });
    return;
  }

  if (requestPath.startsWith("/cesium/")) {
    const cesiumPath = resolveFile(CESIUM_DIR, requestPath.slice("/cesium".length) || "/");
    if (!cesiumPath) {
      send(res, 403, "Forbidden");
      return;
    }

    fs.readFile(cesiumPath, (error, data) => {
      if (error) {
        send(res, 404, "Not found");
        return;
      }

      const ext = path.extname(cesiumPath).toLowerCase();
      send(res, 200, data, {
        "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream",
        "Cache-Control": "public, max-age=3600",
      });
    });
    return;
  }

  const filePath = resolveFile(STATIC_DIR, requestPath || "/");

  if (!filePath) {
    send(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(res, 404, "Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, data, {
      "Content-Type": CONTENT_TYPES[ext] || "application/octet-stream",
    });
  });
});

server.listen(PORT, () => {
  console.log(`Karlsruhe walk app listening on http://localhost:${PORT} (${SERVE_DIST ? "dist" : "public"})`);
});
