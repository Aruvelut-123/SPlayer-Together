/**
 * 安全的路径拼接与 URL 规范化工具
 */

/**
 * 规范化 URL，移除末尾斜杠
 * @param url - 原始 URL 字符串
 * @returns 规范化后的 URL 字符串
 */
export const normalizeUrl = (url: string): string => {
  return url.trim().replace(/\/+$/, "");
};

/**
 * 规范化路径，确保以斜杠开头，且不以斜杠结尾（除非是根目录 "/"）
 * @param path - 原始路径
 * @returns 规范化后的路径
 */
export const normalizePath = (path: string): string => {
  let normalized = path.replace(/\\/g, "/").trim();
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
};

/**
 * 检查路径是否安全（不允许包含 ..、跨域等）
 * @param path - 待检查的路径
 * @param rootPath - 基础根目录
 * @returns 路径是否安全
 */
export const isPathSafe = (path: string, rootPath: string): boolean => {
  const normalizedRoot = normalizePath(rootPath);
  const normalizedPath = normalizePath(path);

  if (normalizedPath.includes("..")) return false;
  if (
    !normalizedPath.startsWith(normalizedRoot === "/" ? "/" : `${normalizedRoot}/`) &&
    normalizedPath !== normalizedRoot
  ) {
    return false;
  }
  return true;
};
