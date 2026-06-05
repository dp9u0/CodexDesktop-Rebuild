#!/usr/bin/env node
/**
 * Post-build patch: Keep wide markdown blocks at full text column width.
 *
 * patch-center-width sets --thread-content-max-width to 100% but leaves
 * --markdown-wide-block-max-width at its upstream value, so code blocks and
 * tables render narrower than the surrounding text in wide windows. This patch
 * binds the wide-block width to the text column width so they match.
 *
 * (Earlier revisions of this patch also reindented options/code blocks under
 * questions; that alignment logic was reverted at the user's request — only the
 * width sync remains.)
 *
 * Usage:
 *   node scripts/patch-prose-alignment.js [platform]   # mac-arm64/mac-x64/win/unix/omit=all
 *   node scripts/patch-prose-alignment.js --check      # Dry-run
 */
const fs = require("fs");
const path = require("path");
const { SRC_DIR, relPath } = require("./patch-util");

const MARKER = "codex-rebuild-prose-alignment";
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
:is([data-codex-window-type=browser],[data-codex-window-type=electron]) body{--markdown-wide-block-max-width:var(--thread-content-max-width,100%)}
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
    label: "prose alignment",
    targets: appMainTargets,
    override: cssOverride(),
    isCheck,
  });

  if (isCheck) {
    console.log(`\n[check] ${changed} file(s) would change`);
  } else {
    console.log(`\n[done] ${changed} file(s) patched`);
  }
}

main();
