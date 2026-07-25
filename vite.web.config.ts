import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { transformSync } from "esbuild";
import { defineConfig, type Plugin } from "vite";

/**
 * Web product build only (rlm-wiki SPA + public share pages).
 *
 * Desktop marketing film pages are outside this package root and must never
 * be Vite inputs here or overwrite dist/public/index.html.
 */
const publicRoot = join(import.meta.dirname, "public");
const distPublicRoot = join(import.meta.dirname, "dist", "public");
const copiedStaticAssets = new Set([
  "ai-icons",
  "android-chrome-192x192.png",
  "android-chrome-512x512.png",
  "apple-touch-icon.png",
  "code-ready-poster.jpg",
  "favicon-16x16.png",
  "favicon-32x32.png",
  "favicon-48x48.png",
  "favicon.ico",
  "github-async-review-preview.html",
  "rlm-wiki-logo.png",
  "site.webmanifest",
]);

function copyStaticPublicAssets(): Plugin {
  return {
    name: "rlm-wiki-copy-static-public-assets",
    generateBundle() {
      const visit = (path: string) => {
        const stat = statSync(path);
        if (stat.isDirectory()) {
          for (const entry of readdirSync(path)) visit(join(path, entry));
          return;
        }
        const fileName = relative(publicRoot, path);
        const topLevel = fileName.split(/[\\/]/)[0];
        if (!copiedStaticAssets.has(topLevel)) return;
        this.emitFile({
          type: "asset",
          fileName,
          source: readFileSync(path),
        });
      };

      for (const entry of readdirSync(publicRoot)) visit(join(publicRoot, entry));
    },
  };
}

function minifyInlineClassicScripts(): Plugin {
  return {
    name: "rlm-wiki-minify-inline-classic-scripts",
    writeBundle() {
      const indexPath = join(distPublicRoot, "index.html");
      if (!statSync(indexPath, { throwIfNoEntry: false })?.isFile()) return;
      const html = readFileSync(indexPath, "utf8");
      const minifiedHtml = html.replace(/<script>([\s\S]*?)<\/script>/g, (_match, code: string) => {
        const minified = transformSync(code, {
          loader: "js",
          minify: true,
          target: "es2020",
          legalComments: "none",
        }).code.trim();
        return `<script>${minified}</script>`;
      });
      writeFileSync(indexPath, minifiedHtml);
    },
  };
}

export default defineConfig({
  root: publicRoot,
  publicDir: false,
  plugins: [copyStaticPublicAssets(), minifyInlineClassicScripts()],
  // Public pages import shared reader UI from ../src/ui (outside public/).
  server: {
    fs: {
      allow: [import.meta.dirname],
    },
  },
  build: {
    outDir: distPublicRoot,
    emptyOutDir: true,
    assetsDir: "assets",
    cssCodeSplit: false,
    minify: "esbuild",
    sourcemap: false,
    rollupOptions: {
      input: {
        // Product SPA only — Wiki / Ask / Code / Review + BYOK
        index: join(publicRoot, "index.html"),
        "public-ask": join(publicRoot, "public-ask.html"),
        "public-wiki": join(publicRoot, "public-wiki.html"),
        "public-wiki-gallery": join(publicRoot, "public-wiki-gallery.html"),
      },
    },
  },
});
