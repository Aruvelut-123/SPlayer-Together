/**
 * 下载文件名工具：模板渲染 + 非法字符清洗 + 重名序号
 */

import { existsSync } from "node:fs";

/** 文件名非法字符 */
const ILLEGAL = /[\\/:*?"<>|]/g;

/** 清洗单个路径段：去非法字符、压缩空白、去首尾空白与点 */
export const sanitizeSegment = (name: string): string =>
  name
    .replace(ILLEGAL, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .trim();

/**
 * 渲染文件名模板（不含扩展名）
 * 支持占位符 {artist} {title} {album}。仅模板里字面的 / 生成子目录；
 * 先按模板切分再逐段填充清洗，占位符值内的 / （如多名歌手）会被当普通字符清掉，不产生子目录
 * @param template - 模板字符串
 * @param vars - 占位符取值
 * @returns 相对基名（可能含子目录分隔），清洗后为空时回退到标题再回退 "untitled"
 */
export const renderFileBase = (
  template: string,
  vars: { artist: string; title: string; album: string },
): string => {
  const segments = template
    .split("/")
    .map((segment) =>
      sanitizeSegment(
        segment
          .replace(/\{artist\}/g, vars.artist)
          .replace(/\{title\}/g, vars.title)
          .replace(/\{album\}/g, vars.album),
      ),
    )
    .filter(Boolean);
  if (segments.length === 0) {
    return sanitizeSegment(vars.title) || "untitled";
  }
  return segments.join("/");
};

/**
 * 目标已存在时追加序号 name (2).ext
 * @param pathWithoutExt - 不含扩展名的完整路径
 * @param ext - 扩展名（含点，可空）
 * @returns 不冲突的完整路径
 */
export const dedupePath = (pathWithoutExt: string, ext: string): string => {
  let target = `${pathWithoutExt}${ext}`;
  for (let seq = 2; existsSync(target); seq++) {
    target = `${pathWithoutExt} (${seq})${ext}`;
  }
  return target;
};

/** Content-Type → 扩展名（含点） */
const MIME_EXT: Record<string, string> = {
  "audio/flac": ".flac",
  "audio/x-flac": ".flac",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/mp4": ".m4a",
  "audio/x-m4a": ".m4a",
  "audio/aac": ".aac",
  "audio/ogg": ".ogg",
  "audio/opus": ".opus",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
};

/** 已知音频扩展名 */
const KNOWN_EXTS = new Set([
  ".flac",
  ".mp3",
  ".m4a",
  ".aac",
  ".ogg",
  ".opus",
  ".wav",
  ".ape",
  ".wv",
  ".aiff",
]);

/**
 * 推断下载文件扩展名（含点）
 * 优先级：已声明格式 → Content-Type → URL 路径后缀 → 兜底 .mp3
 * @param declaredFormat - 已知格式（如 netease 的 flac/mp3）
 * @param contentType - 响应 Content-Type
 * @param url - 音频 URL
 */
export const resolveExtension = (
  declaredFormat: string | undefined,
  contentType: string | null,
  url: string,
): string => {
  if (declaredFormat) {
    const ext = declaredFormat.startsWith(".") ? declaredFormat : `.${declaredFormat}`;
    if (KNOWN_EXTS.has(ext.toLowerCase())) return ext.toLowerCase();
  }
  if (contentType) {
    const mime = contentType.split(";")[0].trim().toLowerCase();
    if (MIME_EXT[mime]) return MIME_EXT[mime];
  }
  const match = url.split("?")[0].match(/\.([a-z0-9]{2,5})$/i);
  if (match) {
    const ext = `.${match[1].toLowerCase()}`;
    if (KNOWN_EXTS.has(ext)) return ext;
  }
  return ".mp3";
};
