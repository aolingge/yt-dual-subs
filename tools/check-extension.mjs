import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.YTDS_EXTENSION_ROOT || fileURLToPath(new URL("..", import.meta.url));
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

let manifest;
try { manifest = JSON.parse(read("manifest.json")); }
catch (error) { failures.push(`manifest.json: ${error.message}`); }

if (manifest) {
  check(manifest.manifest_version === 3, "manifest_version must be 3");
  check(Number(manifest.minimum_chrome_version) >= 116, "worker/offscreen capture requires Chrome 116+");
  check(/^\d+\.\d+\.\d+$/.test(manifest.version || ""), "manifest version must be three-part semver");
  const permissions = [
    ...(manifest.permissions || []),
    ...(manifest.host_permissions || []),
    ...(manifest.optional_host_permissions || [])
  ];
  check(!permissions.some((value) => /^(<all_urls>|\*:\/\/\*\/\*|https?:\/\/\*\/\*)$/.test(value)),
    "broad all-sites permission found");
  const matches = (manifest.content_scripts || []).flatMap((entry) => entry.matches || []);
  check(matches.every((value) => /^https:\/\/www\.(youtube\.com|bilibili\.com)\/.+/.test(value)),
    "content script match is outside YouTube/Bilibili HTTPS hosts");
  const assets = new Set([manifest.background?.service_worker, manifest.action?.default_popup,
    ...Object.values(manifest.icons || {}), ...Object.values(manifest.action?.default_icon || {}),
    ...(manifest.content_scripts || []).flatMap(entry => [...(entry.js || []), ...(entry.css || [])])].filter(Boolean));
  for (const file of fs.readdirSync(root).filter(file => /\.(?:js|html)$/.test(file))) {
    const source = read(file);
    if (file.endsWith('.html')) {
      for (const match of source.matchAll(/(?:src|href)=["']([^"'#?]+)["']/g)) {
        if (!/^(?:https?:|data:|\/\/)/.test(match[1])) assets.add(match[1]);
      }
    } else {
      for (const call of source.matchAll(/(?:importScripts|\.addModule|\.getURL)\(\s*([^)]*)\)/g)) {
        for (const match of call[1].matchAll(/["']([^"']+\.(?:js|html))["']/g)) assets.add(match[1]);
      }
    }
  }
  for (const asset of assets) check(fs.existsSync(path.join(root, asset)), `missing runtime asset ${asset}`);
}

check(read("word-timing.js") === read("word-timing-page.js"),
  "word-timing.js and word-timing-page.js differ");

const version = manifest?.version || "";
for (const file of ["README.md", "README.zh-CN.md", "docs/PRIVACY.md"]) {
  check(read(file).includes(version), `${file} does not mention source version ${version}`);
}

const locales = {};
for (const locale of ["en", "zh_CN", "zh_TW"]) {
  try { locales[locale] = JSON.parse(read(`_locales/${locale}/messages.json`)); }
  catch (error) { failures.push(`${locale} messages: ${error.message}`); }
}
const asked = new Set();
for (const file of ["popup.html", "alignment.html"]) {
  for (const match of read(file).matchAll(/data-i18n(?:-html|-title|-aria|-placeholder)?="([^"]+)"/g)) asked.add(match[1]);
}
for (const file of ["popup.js", "study.js", "content.js", "alignment.js"]) {
  for (const match of read(file).matchAll(/\bt\(\s*["']([A-Za-z0-9_]+)["']/g)) asked.add(match[1]);
}
for (const key of asked) {
  for (const locale of Object.keys(locales)) check(!!locales[locale]?.[key], `${locale} missing locale key ${key}`);
}
// These labels are selected through the input-state map, not literal t(...) calls.
for (const key of ["recogInputPaused", "recogInputWaiting", "recogInputSignal", "recogInputSilent",
  "recogInputMissing", "recogInputSuspended", "recogInputMediaWaiting", "recogCaptureEnded"]) {
  for (const locale of Object.keys(locales)) check(!!locales[locale]?.[key], `${locale} missing locale key ${key}`);
  asked.add(key);
}

if (failures.length) {
  console.error(failures.map((message) => `FAIL ${message}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`ok: manifest ${version}, ${asked.size} localized keys, timing copies synchronized`);
}
