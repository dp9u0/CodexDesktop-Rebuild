#!/usr/bin/env node
/**
 * Post-build patch: Widen the main centered Codex workspace.
 *
 * This targets the surfaces users usually describe as the "middle dialog":
 * - the main thread/composer column controlled by --thread-content-max-width
 * - home/starter sections using mx-auto + max-w-3xl
 * - the centered command menu dialog in composer CSS
 *
 * Usage:
 *   node scripts/patch-center-width.js [platform]   # mac-arm64/mac-x64/win/unix/omit=all
 *   node scripts/patch-center-width.js --check      # Dry-run
 */
const fs = require("fs");
const path = require("path");
const { SRC_DIR, relPath } = require("./patch-util");

const MARKER = "codex-rebuild-center-width";
const MARKER_START = `/* ${MARKER}: start */`;
const MARKER_END = `/* ${MARKER}: end */`;
const THREAD_WIDTH = "100%";
const COMMAND_MENU_WIDTH = "800px";

function resolvePlatforms(platform) {
  if (platform === "unix") return ["mac-arm64", "mac-x64"];
  if (platform) return [platform];
  return ["mac-arm64", "mac-x64", "win"];
}

function assetDirs(platform) {
  const dirs = [];
  for (const plat of resolvePlatforms(platform)) {
    dirs.push({
      platform: plat,
      dir: path.join(SRC_DIR, plat, "_asar", "webview", "assets"),
    });
  }

  if (!platform) {
    dirs.push({
      platform: "legacy",
      dir: path.join(SRC_DIR, "webview", "assets"),
    });
  }

  return dirs.filter((entry) => fs.existsSync(entry.dir));
}

function locateCss(platform, pattern) {
  const targets = [];
  for (const entry of assetDirs(platform)) {
    for (const file of fs.readdirSync(entry.dir)) {
      if (pattern.test(file)) {
        targets.push({ platform: entry.platform, path: path.join(entry.dir, file) });
      }
    }
  }
  return targets;
}

function appMainCssOverride() {
  return `
${MARKER_START}
:is([data-codex-window-type=browser],[data-codex-window-type=electron]) body{--thread-content-max-width:${THREAD_WIDTH}}
.mx-auto.max-w-3xl{width:100%;max-width:${THREAD_WIDTH};margin-left:0!important;margin-right:0!important}
[class~="mx-auto"][class*="w-[min(100%,var(--thread-content-max-width))]"],[class~="mx-auto"][class*="max-w-[var(--thread-content-max-width)]"],[class~="mx-auto"][class*="max-w-(--thread-content-max-width)"]{width:100%!important;max-width:${THREAD_WIDTH};margin-left:0!important;margin-right:0!important}
${MARKER_END}
`;
}

function composerCssOverride() {
  return `
${MARKER_START}
.command-menu-dialog{width:min(${COMMAND_MENU_WIDTH},calc(92vw / var(--codex-window-zoom,1)))}
${MARKER_END}
`;
}

function patchCss(source, override) {
  const escapedMarker = MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedStart = MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedEnd = MARKER_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  let base = source.replace(new RegExp(`\\n?${escapedStart}[\\s\\S]*?${escapedEnd}\\n?`, "g"), "\n");
  // Remove legacy one-shot blocks generated before explicit start/end markers existed.
  base = base.replace(new RegExp(`\\n?\\/\\* ${escapedMarker}:[^*]*\\*\\/\\n(?:[^\\n]*\\n){1,8}`, "g"), "\n");
  base = base.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");

  const code = base + override;
  return { code, changed: code !== source };
}

function patchTargets({ label, targets, override, isCheck }) {
  let changed = 0;

  if (targets.length === 0) {
    console.warn(`  [!] No ${label} CSS bundle found`);
    return changed;
  }

  for (const target of targets) {
    console.log(`\n-- [${target.platform}] ${relPath(target.path)}`);
    const source = fs.readFileSync(target.path, "utf-8");
    const result = patchCss(source, override);

    if (!result.changed) {
      console.log(`   [ok] ${label} width CSS already present`);
      continue;
    }

    changed++;
    console.log(`   * append ${label} width override`);

    if (!isCheck) {
      fs.writeFileSync(target.path, result.code, "utf-8");
      console.log(`   [ok] ${label} width CSS appended`);
    }
  }

  return changed;
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((arg) => ["mac-arm64", "mac-x64", "win", "unix"].includes(arg));

  const appMainTargets = locateCss(platform, /^app-main-.+\.css$/);
  const composerTargets = locateCss(platform, /^composer-.+\.css$/);

  let changed = 0;
  changed += patchTargets({
    label: "main center",
    targets: appMainTargets,
    override: appMainCssOverride(),
    isCheck,
  });
  changed += patchTargets({
    label: "command menu",
    targets: composerTargets,
    override: composerCssOverride(),
    isCheck,
  });

  console.log(`\n[done] center width patch: ${isCheck ? "dry-run, " : ""}${changed} CSS change(s)`);
}

if (require.main === module) {
  main();
}

module.exports = { patchCss, appMainCssOverride, composerCssOverride };
