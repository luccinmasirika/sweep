import { defineConfig, type Plugin } from "vite";

// WKWebView blocks module scripts/styles tagged crossorigin when served over the
// tauri:// custom protocol, which leaves the window blank white. Strip the
// attribute from the generated tags so the bundle and its CSS actually load.
function stripCrossorigin(): Plugin {
  return {
    name: "strip-crossorigin",
    enforce: "post",
    transformIndexHtml(html) {
      return html.replace(/\s+crossorigin/g, "");
    },
  };
}

// Tauri expects a fixed dev port and serves the built assets from dist/.
export default defineConfig({
  clearScreen: false,
  base: "./",
  plugins: [stripCrossorigin()],
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "esnext",
    outDir: "dist",
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name].[ext]",
      },
    },
  },
});
