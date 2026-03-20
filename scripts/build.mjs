import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const publicDir = path.join(rootDir, "public");
const distDir = path.join(rootDir, "dist");
const outputDir = process.env.BUILD_OUT_DIR
  ? path.resolve(rootDir, process.env.BUILD_OUT_DIR)
  : distDir;
const cesiumSourceDir = path.join(rootDir, "node_modules", "cesium", "Build", "Cesium");
const cesiumDistDir = path.join(outputDir, "cesium");

const runtimeConfig = {
  freeOnly: true,
  qualityMode: "local",
};

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });
fs.cpSync(publicDir, outputDir, { recursive: true });
fs.cpSync(cesiumSourceDir, cesiumDistDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, ".nojekyll"), "", "utf8");
fs.writeFileSync(
  path.join(outputDir, "runtime-config.js"),
  `window.__KARLSRUHE_WALK_CONFIG__ = ${JSON.stringify(runtimeConfig, null, 2)};\n`,
  "utf8"
);

console.log(`Built Karlsruhe Walk into ${path.relative(rootDir, outputDir) || "."}/`);
