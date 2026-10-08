import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

// 확장 본체 (Node 환경, VS Code API 사용)
const extension = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  sourcemap: true,
};

// 웹뷰 화면 (브라우저 환경, React)
const webview = {
  entryPoints: ["webview/index.tsx"],
  bundle: true,
  outfile: "dist/webview.js",
  platform: "browser",
  format: "iife",
  target: "es2020",
  sourcemap: true,
  loader: { ".css": "css" },
};

if (watch) {
  const [a, b] = await Promise.all([esbuild.context(extension), esbuild.context(webview)]);
  await Promise.all([a.watch(), b.watch()]);
  console.log("watching...");
} else {
  await Promise.all([esbuild.build(extension), esbuild.build(webview)]);
  console.log("built.");
}
