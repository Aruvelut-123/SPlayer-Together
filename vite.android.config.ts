import { resolve } from "node:path";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import UnoCSS from "unocss/vite";
import AutoImport from "unplugin-auto-import/vite";
import Icons from "unplugin-icons/vite";
import IconsResolver from "unplugin-icons/resolver";
import { FileSystemIconLoader } from "unplugin-icons/loaders";
import RekaResolver from "reka-ui/resolver";
import Components from "unplugin-vue-components/vite";
import pkg from "./package.json" with { type: "json" };

const root = __dirname;

export default defineConfig({
  base: "./",
  root,
  publicDir: resolve(root, "public"),
  plugins: [
    vue(),
    UnoCSS(),
    AutoImport({
      imports: ["vue", "pinia", "vue-router", "@vueuse/core", "vue-i18n"],
      eslintrc: { enabled: true, filepath: "./auto-eslint.mjs" },
    }),
    Icons({
      compiler: "vue3",
      scale: 1,
      customCollections: { sp: FileSystemIconLoader("./src/assets/icons") },
    }),
    Components({
      dirs: ["src/components"],
      resolvers: [RekaResolver(), IconsResolver({ prefix: "icon", customCollections: ["sp"] })],
    }),
  ],
  resolve: {
    alias: {
      "@": resolve(root, "src"),
      "@shared": resolve(root, "shared"),
      "@windows": resolve(root, "windows"),
      "@root": root,
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_REPO_URL__: JSON.stringify(pkg.repository.url),
    __APP_REPO_NAME__: JSON.stringify(pkg.productName),
    __APP_AUTHOR__: JSON.stringify(pkg.author.name),
    __APP_HOMEPAGE__: JSON.stringify(pkg.homepage),
    __APP_AUTHOR_URL__: JSON.stringify(pkg.author.url),
    __COMMIT_HASH__: JSON.stringify("android"),
    __COMMIT_DATE__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    outDir: resolve(root, "dist/capacitor"),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: { input: resolve(root, "index.html") },
  },
});
