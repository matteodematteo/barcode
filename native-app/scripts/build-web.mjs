import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const nativeRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const appRoot = resolve(nativeRoot, "..");
const webRoot = resolve(nativeRoot, "www");
const assets = ["index.html", "manifest.webmanifest", "manifest.ios.webmanifest", "sw.js",
  "apple-touch-icon.png", "icon-192.png", "icon-512.png", "js", "css"];

const sourceBuild = spawnSync("python", ["build.py"], { cwd: appRoot, stdio: "inherit" });
if (sourceBuild.status !== 0) throw new Error("The Web Scanner source build failed.");

await rm(webRoot, { recursive: true, force: true });
await mkdir(webRoot, { recursive: true });
for (const asset of assets) await cp(resolve(appRoot, asset), resolve(webRoot, asset), { recursive: true });
await build({
  absWorkingDir: nativeRoot,
  entryPoints: ["plugins/native-barcode-capture/src/bridge.ts"],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: ["es2020"],
  outfile: "www/js/native-barcode-bridge.js",
  logLevel: "warning"
});
await build({
  absWorkingDir: nativeRoot,
  entryPoints: ["plugins/native-barcode-capture/src/index.ts"],
  bundle: true,
  platform: "browser",
  format: "esm",
  target: ["es2020"],
  outfile: "plugins/native-barcode-capture/dist/plugin.js",
  logLevel: "warning"
});
await build({
  absWorkingDir: nativeRoot,
  entryPoints: ["plugins/native-barcode-capture/src/index.ts"],
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: ["es2020"],
  outfile: "plugins/native-barcode-capture/dist/plugin.cjs.js",
  logLevel: "warning"
});

const htmlPath = resolve(webRoot, "index.html");
let html = await readFile(htmlPath, "utf8");
const marker = '<script src="js/app.bundle.js?v=';
if (!html.includes(marker)) throw new Error("Could not locate the app bootstrap script in index.html");
html = html.replace(marker,
  '<script src="js/native-barcode-bridge.js" defer></script>\n  ' + marker);
await writeFile(htmlPath, html, "utf8");
console.log("Prepared Capacitor Web Scanner assets and native bridge.");
