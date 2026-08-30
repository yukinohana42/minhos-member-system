import { copyFile, mkdir, readFile } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("dist", { recursive: true });

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/Code.js",
  bundle: true,
  format: "iife",
  globalName: "MinhosAppsScript",
  platform: "browser",
  target: "es2020",
  sourcemap: false,
  minify: false,
  legalComments: "none",
  footer: {
    js: [
      "function hourlySync() { return MinhosAppsScript.hourlySync(); }",
      "function nightlySync() { return MinhosAppsScript.nightlySync(); }",
      "function manualSync() { return MinhosAppsScript.manualSync(); }",
      "function resumeSync(e) { return MinhosAppsScript.resumeSync(e); }",
      "function dailyBackup() { return MinhosAppsScript.dailyBackup(); }",
      "function monthlyBackup() { return MinhosAppsScript.monthlyBackup(); }",
      "function installMinhosTriggers() { return MinhosAppsScript.installMinhosTriggers(); }",
      "function initializeMinhosWorkbook() { return MinhosAppsScript.initializeMinhosWorkbook(); }",
      "function onProfileFormSubmit(e) { return MinhosAppsScript.onProfileFormSubmit(e); }",
      "function retryProfileFormSubmissions(e) { return MinhosAppsScript.retryProfileFormSubmissions(e); }",
    ].join("\n"),
  },
});

const bundledCode = await readFile("dist/Code.js", "utf8");
if (/\.\s*at\s*\(/u.test(bundledCode)) {
  throw new Error("ES2020_COMPATIBILITY_FAILURE:Array.at");
}

await copyFile("appsscript.json", "dist/appsscript.json");
