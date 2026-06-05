#!/usr/bin/env node
/**
 * Post-build patch: Render Markdown bold text in green.
 *
 * Markdown **bold** is rendered as a <strong> element inside the markdown
 * content root. This patch scopes the color override to markdown output only,
 * so ordinary UI labels and buttons keep their upstream styles.
 *
 * Usage:
 *   node scripts/patch-bold-color.js [platform]   # mac-arm64/mac-x64/win/unix/omit=all
 *   node scripts/patch-bold-color.js --check      # Dry-run
 */
const fs = require("fs");
const path = require("path");
const { SRC_DIR, relPath } = require("./patch-util");

const MARKER = "codex-rebuild-bold-color";
const MARKER_START = `/* ${MARKER}: start */`;
const MARKER_END = `/* ${MARKER}: end */`;

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

function cssOverride() {
  return `
${MARKER_START}
:is([data-codex-window-type=browser],[data-codex-window-type=chrome-extension],[data-codex-window-type=electron]) [data-selected-text-overlay-target] strong{color:var(--color-token-charts-green,var(--green-500,#00a240))}
${MARKER_END}
`;
}

function patchCss(source, override) {
  const escapedStart = MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedEnd = MARKER_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  let base = source.replace(new RegExp(`\\n?${escapedStart}[\\s\\S]*?${escapedEnd}\\n?`, "g"), "\n");
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
      console.log(`   [ok] ${label} CSS already present`);
      continue;
    }

    changed++;
    console.log(`   * append ${label} override`);

    if (!isCheck) {
      fs.writeFileSync(target.path, result.code, "utf-8");
      console.log(`   [ok] ${label} CSS appended`);
    }
  }

  return changed;
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((arg) => ["mac-arm64", "mac-x64", "win", "unix"].includes(arg));

  const appMainTargets = locateCss(platform, /^app-main-.+\.css$/);

  const changed = patchTargets({
    label: "bold color",
    targets: appMainTargets,
    override: cssOverride(),
    isCheck,
  });

  console.log(`\n[done] bold color patch: ${isCheck ? "dry-run, " : ""}${changed} CSS change(s)`);
}

if (require.main === module) {
  main();
}

module.exports = { patchCss, cssOverride };
