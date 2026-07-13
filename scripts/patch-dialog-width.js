#!/usr/bin/env node
/**
 * Post-build patch: Widen shared centered dialogs.
 *
 * Codex keeps common dialog widths in the shared dialog chunk:
 *   narrow -> w-[380px], default -> w-[520px], wide -> w-[600px], ...
 *
 * This rewrites that size map and appends CSS definitions for the target
 * arbitrary-width classes, so the patch remains stable even if the generated
 * Tailwind CSS for a future build does not already include every target width.
 *
 * Usage:
 *   node scripts/patch-dialog-width.js [platform]   # mac-arm64/mac-x64/win/unix/omit=all
 *   node scripts/patch-dialog-width.js --check      # Dry-run
 */
const fs = require("fs");
const path = require("path");
const { SRC_DIR, relPath } = require("./patch-util");

const MARKER = "codex-rebuild-dialog-width";

const DIALOG_WIDTHS = {
  narrow: "w-[520px]",
  feature: "w-[600px]",
  compact: "w-[640px]",
  wide: "w-[800px]",
  xwide: "w-[860px]",
  xxwide: "w-[1040px]",
  editor: "w-[800px] h-[720px] max-w-full max-h-full",
  default: "w-[720px]",
};

const SIZE_KEYS = ["narrow", "feature", "compact", "wide", "xwide", "xxwide", "editor"];
const TARGET_WIDTHS = [...new Set(Object.values(DIALOG_WIDTHS).map((value) => value.match(/w-\[(\d+)px\]/)?.[1]).filter(Boolean))];

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

  // Legacy fallback for a flat src/ layout.
  if (!platform) {
    dirs.push({
      platform: "legacy",
      dir: path.join(SRC_DIR, "webview", "assets"),
    });
  }

  return dirs.filter((entry) => fs.existsSync(entry.dir));
}

function locateAssets(platform, pattern) {
  const results = [];
  for (const entry of assetDirs(platform)) {
    const files = fs.readdirSync(entry.dir).filter((file) => pattern.test(file));
    for (const file of files) {
      results.push({ platform: entry.platform, path: path.join(entry.dir, file) });
    }
  }
  return results;
}

function isDialogSizeMap(expr) {
  if (!expr.includes("w-[")) return false;
  return SIZE_KEYS.every((key) => expr.includes("`" + key + "`") || expr.includes(`"${key}"`) || expr.includes(`'${key}'`));
}

function buildSizeMapFunction(name, arg) {
  return `function ${name}(${arg}){return ${arg}===\`narrow\`?\`${DIALOG_WIDTHS.narrow}\`:${arg}===\`feature\`?\`${DIALOG_WIDTHS.feature}\`:${arg}===\`compact\`?\`${DIALOG_WIDTHS.compact}\`:${arg}===\`wide\`?\`${DIALOG_WIDTHS.wide}\`:${arg}===\`xwide\`?\`${DIALOG_WIDTHS.xwide}\`:${arg}===\`xxwide\`?\`${DIALOG_WIDTHS.xxwide}\`:${arg}===\`editor\`?\`${DIALOG_WIDTHS.editor}\`:\`${DIALOG_WIDTHS.default}\`}`;
}

function patchDialogJs(source) {
  let found = 0;
  let changed = 0;
  const patches = [];

  const code = source.replace(
    /function\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{\s*return\s+([^{}]+?)\s*\}/g,
    (match, name, arg, expr, offset) => {
      if (!isDialogSizeMap(expr)) return match;
      found++;

      const replacement = buildSizeMapFunction(name, arg);
      if (replacement === match) {
        patches.push({ offset, changed: false, original: match, replacement });
        return match;
      }

      changed++;
      patches.push({ offset, changed: true, original: match, replacement });
      return replacement;
    },
  );

  return { code, found, changed, patches };
}

function dialogWidthCss() {
  const rules = TARGET_WIDTHS.map((width) => `.codex-dialog.w-\\[${width}px\\]{width:${width}px}`).join("");
  return `\n/* ${MARKER}: widened shared dialog size classes. */\n${rules}\n`;
}

function patchDialogCss(source) {
  if (source.includes(MARKER)) return { code: source, changed: false };
  return { code: source + dialogWidthCss(), changed: true };
}

function main() {
  const args = process.argv.slice(2);
  const isCheck = args.includes("--check");
  const platform = args.find((arg) => ["mac-arm64", "mac-x64", "win", "unix"].includes(arg));

  const jsTargets = locateAssets(platform, /^dialog(?:-.+)?\.js$/);
  const cssTargets = locateAssets(platform, /^dialog(?:-.+)?\.css$/);

  if (jsTargets.length === 0) {
    console.error("[x] No dialog JS bundle found. Run sync-upstream first.");
    process.exit(1);
  }

  let mapsFound = 0;
  let jsChanged = 0;

  for (const target of jsTargets) {
    console.log(`\n-- [${target.platform}] ${relPath(target.path)}`);
    const source = fs.readFileSync(target.path, "utf-8");
    const result = patchDialogJs(source);

    if (result.found === 0) {
      console.log("   [skip] no shared dialog size map");
      continue;
    }

    mapsFound += result.found;
    jsChanged += result.changed;

    for (const patch of result.patches) {
      if (patch.changed) {
        console.log(`   * offset ${patch.offset}: dialog size map -> widened`);
      } else {
        console.log(`   [ok] offset ${patch.offset}: already widened`);
      }
    }

    if (isCheck) continue;
    if (result.changed > 0) {
      fs.writeFileSync(target.path, result.code, "utf-8");
      console.log(`   [ok] dialog width map updated: ${result.changed} replacement(s)`);
    }
  }

  if (mapsFound === 0) {
    console.error("[x] Shared dialog size map not found in dialog bundles.");
    process.exit(1);
  }

  if (cssTargets.length === 0) {
    console.warn("  [!] No dialog CSS bundle found; relying on existing generated width classes.");
  }

  let cssChanged = 0;
  for (const target of cssTargets) {
    console.log(`\n-- [${target.platform}] ${relPath(target.path)}`);
    const source = fs.readFileSync(target.path, "utf-8");
    const result = patchDialogCss(source);

    if (!result.changed) {
      console.log("   [ok] dialog width CSS already present");
      continue;
    }

    cssChanged++;
    console.log(`   * append CSS classes for ${TARGET_WIDTHS.map((width) => `w-[${width}px]`).join(", ")}`);

    if (!isCheck) {
      fs.writeFileSync(target.path, result.code, "utf-8");
      console.log("   [ok] dialog width CSS appended");
    }
  }

  console.log(`\n[done] dialog width patch: ${isCheck ? "dry-run, " : ""}${jsChanged} JS change(s), ${cssChanged} CSS change(s)`);
}

if (require.main === module) {
  main();
}

module.exports = { patchDialogJs, patchDialogCss, DIALOG_WIDTHS };
