const ENCODED_SEPARATOR_PATTERN = /%2f|%5c/i;

/**
 * 规范化 WebDAV 服务地址
 * @param value - 用户输入的服务地址
 * @returns 去除查询、片段和尾部斜杠的 URL
 */
export const normalizeWebDavBaseUrl = (value: string): URL => {
  const url = new URL(value.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("WebDAV 仅支持 HTTP 或 HTTPS 地址");
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
};

/**
 * 规范化用户配置的根目录
 * @param value - 用户输入的根目录
 * @returns 以斜杠开头的解码路径
 */
const normalizePath = (value: string, allowLiteralPercent: boolean): string => {
  const source = value.trim().replace(/\\/g, "/") || "/";
  if (ENCODED_SEPARATOR_PATTERN.test(source)) throw new Error("WebDAV 路径包含非法分隔符");
  let decoded: string;
  try {
    const encoded = allowLiteralPercent ? source.replace(/%(?![\da-f]{2})/gi, "%25") : source;
    decoded = decodeURIComponent(encoded);
  } catch {
    throw new Error("WebDAV 路径包含无效编码");
  }
  const segments = decoded.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("WebDAV 路径不能包含相对目录");
  }
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
};

/**
 * 规范化用户配置的根目录
 * @param value - 用户输入的根目录
 * @returns 以斜杠开头的解码路径
 */
export const normalizeWebDavRootPath = (value: string): string => normalizePath(value, true);

/**
 * 构建配置根目录的请求地址
 * @param baseUrl - WebDAV 服务地址
 * @param rootPath - 用户配置的根目录
 * @returns 经过逐段编码的根目录 URL
 */
export const createWebDavRootUrl = (baseUrl: string, rootPath: string): URL => {
  const url = normalizeWebDavBaseUrl(baseUrl);
  const normalizedRoot = normalizeWebDavRootPath(rootPath);
  const baseSegments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const rootSegments = normalizedRoot.split("/").filter(Boolean);
  url.pathname = [...baseSegments, ...rootSegments]
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  url.pathname = `/${url.pathname.replace(/^\/+|\/+$/g, "")}/`;
  return url;
};

/**
 * 在配置根目录内构建文件请求地址
 * @param rootUrl - 配置根目录地址
 * @param relativePath - 扫描得到的根目录相对路径
 * @returns 经过逐段编码的文件 URL
 */
export const createWebDavResourceUrl = (rootUrl: URL, relativePath: string): URL => {
  const normalized = normalizePath(relativePath, true);
  if (normalized === "/") throw new Error("WebDAV 文件路径不能为空");
  const url = new URL(rootUrl);
  const rootSegments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const resourceSegments = normalized.split("/").filter(Boolean);
  url.pathname = `/${[...rootSegments, ...resourceSegments]
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
  return url;
};

/**
 * 解析并校验 PROPFIND 返回的 href
 * @param href - 服务端返回的资源地址
 * @param requestUrl - 当前 PROPFIND 请求地址
 * @param rootUrl - 配置根目录地址
 * @returns 安全资源的 URL、规范路径和根目录相对路径
 */
export const resolveWebDavHref = (
  href: string,
  requestUrl: URL,
  rootUrl: URL,
): { url: URL; path: string; relativePath: string } => {
  const source = href.trim();
  if (!source || source.startsWith("//") || ENCODED_SEPARATOR_PATTERN.test(source)) {
    throw new Error("WebDAV 返回了非法资源地址");
  }
  let url: URL;
  try {
    url = new URL(source, requestUrl);
  } catch {
    throw new Error("WebDAV 返回了无效资源地址");
  }
  if (url.origin !== rootUrl.origin || url.username || url.password) {
    throw new Error("WebDAV 返回了跨域资源地址");
  }
  let path: string;
  let rootPath: string;
  try {
    path = normalizePath(url.pathname, false);
    rootPath = normalizePath(rootUrl.pathname, false);
  } catch {
    throw new Error("WebDAV 返回了无效编码的资源地址");
  }
  if (path !== rootPath && !path.startsWith(`${rootPath === "/" ? "" : rootPath}/`)) {
    throw new Error("WebDAV 返回了根目录之外的资源地址");
  }
  url.hash = "";
  url.search = "";
  const relativePath =
    path === rootPath ? "" : path.slice(rootPath === "/" ? 1 : rootPath.length + 1);
  return { url, path, relativePath };
};
