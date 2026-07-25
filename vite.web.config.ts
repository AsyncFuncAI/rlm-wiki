import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { transformSync } from "esbuild";
import { defineConfig, type Plugin } from "vite";

const publicRoot = join(import.meta.dirname, "public");
const distPublicRoot = join(import.meta.dirname, "dist", "public");
const copiedStaticAssets = new Set([
  "ai-icons",
  "android-chrome-192x192.png",
  "android-chrome-512x512.png",
  "apple-touch-icon.png",
  "code-ready-poster.jpg",
  "episodes",
  "favicon-16x16.png",
  "favicon-32x32.png",
  "favicon-48x48.png",
  "favicon.ico",
  "github-async-review-preview.html",
  "rlm-wiki-logo.png",
  "rlm-wiki-preview-bottom-left.png",
  "rlm-wiki-preview.png",
  "rlm-wiki-preview-90s-office.png",
  "rlm-wiki-wordmark.json",
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

function withoutInjectedAppStyles(html: string): string {
  return html.replace(
    /\s*<link rel="stylesheet" crossorigin href="\/assets\/style-[^"]+\.css">/g,
    "",
  );
}

// Marketing film page (public/rlm-wiki.html) is a separate route only.
// Never overwrite dist/public/index.html — that file is the real product SPA
// (Wiki / Ask / Code / Review + BYOK model access + cinematic home hero).
function publishMarketingLanding(): Plugin {
  return {
    name: "rlm-wiki-publish-marketing-landing",
    writeBundle() {
      const landingPath = join(distPublicRoot, "rlm-wiki.html");
      if (!statSync(landingPath, { throwIfNoEntry: false })?.isFile()) return;
      const landingHtml = withoutInjectedAppStyles(readFileSync(landingPath, "utf8"));
      writeFileSync(landingPath, landingHtml);
    },
  };
}

export default defineConfig({
  root: publicRoot,
  publicDir: false,
  plugins: [copyStaticPublicAssets(), minifyInlineClassicScripts(), publishMarketingLanding()],
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
        index: join(publicRoot, "index.html"),
        changelog: join(publicRoot, "changelog.html"),
        episodes: join(publicRoot, "episodes.html"),
        "rlm-wiki": join(publicRoot, "rlm-wiki.html"),
        "public-ask": join(publicRoot, "public-ask.html"),
        "public-wiki": join(publicRoot, "public-wiki.html"),
        "public-wiki-gallery": join(publicRoot, "public-wiki-gallery.html"),
      },
    },
  },
});
