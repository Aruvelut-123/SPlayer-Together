import { readFileSync, writeFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import JavaScriptObfuscator, { type ObfuscatorOptions } from "javascript-obfuscator";

/**
 * 混淆 electron-vite 构建产物（out/）下的全部 JS 并删除 sourcemap。
 * 在 ``electron-vite build`` 之后、``electron-builder`` 打包之前执行。
 */

const OUT_DIR = "out";

/** 递归收集 .js 文件，同时删除 .js.map 防止泄露源码 */
const collectJs = (dir: string): string[] => {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      files.push(...collectJs(full));
    } else if (name.endsWith(".js")) {
      files.push(full);
    } else if (name.endsWith(".js.map")) {
      rmSync(full);
    }
  }
  return files;
};

const options: ObfuscatorOptions = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.6,
  deadCodeInjection: false,
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: false,
  selfDefending: true,
  stringArray: true,
  stringArrayEncoding: ["base64"],
  stringArrayThreshold: 0.6,
  splitStrings: true,
  splitStringsChunkLength: 12,
  transformObjectKeys: true,
};

const files = collectJs(OUT_DIR);
for (const file of files) {
  const code = readFileSync(file, "utf8");
  const result = JavaScriptObfuscator.obfuscate(code, options);
  writeFileSync(file, result.getObfuscatedCode());
  console.log(`obfuscated: ${file}`);
}
console.log(`obfuscated ${files.length} files`);
