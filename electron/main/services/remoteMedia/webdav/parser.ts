import { XMLParser } from "fast-xml-parser";
import { resolveWebDavHref } from "./paths";

const MAX_XML_DEPTH = 64;
const FORBIDDEN_XML_PATTERN = /<!\s*(?:DOCTYPE|ENTITY)\b/i;

interface RawPropStat {
  status?: string;
  prop?: {
    resourcetype?: { collection?: unknown } | string;
    getcontenttype?: string;
    getcontentlength?: string;
    getlastmodified?: string;
    getetag?: string;
  };
}

interface RawResponse {
  href?: string;
  propstat?: RawPropStat | RawPropStat[];
}

interface RawMultiStatus {
  response?: RawResponse | RawResponse[];
}

/** WebDAV 目录资源 */
export interface WebDavResource {
  href: string;
  path: string;
  relativePath: string;
  isCollection: boolean;
  contentType?: string;
  contentLength?: number;
  lastModified?: string;
  etag?: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false,
  processEntities: false,
});

/**
 * 确认 multistatus 元素属于 DAV 命名空间
 * @param xml - 原始 XML
 */
const assertDavNamespace = (xml: string): void => {
  const root = xml.match(/<(?:([\w.-]+):)?multistatus\b([^>]*)>/i);
  if (!root) throw new Error("WebDAV XML 缺少 multistatus 根元素");
  const prefix = root[1];
  const attributes = root[2];
  const namespacePattern = prefix
    ? new RegExp(
        `\\bxmlns:${prefix.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*=\\s*["']DAV:["']`,
        "i",
      )
    : /\bxmlns\s*=\s*["']DAV:["']/i;
  if (!namespacePattern.test(attributes)) throw new Error("WebDAV XML 使用了错误的命名空间");
};

/**
 * 检查 XML 嵌套层数
 * @param xml - 原始 XML
 */
const assertXmlDepth = (xml: string): void => {
  let depth = 0;
  for (const match of xml.matchAll(/<\s*(\/)?\s*([\w:.-]+)(?:\s[^<>]*?)?(\/)?\s*>/g)) {
    if (match[1]) depth -= 1;
    else if (!match[3]) depth += 1;
    if (depth > MAX_XML_DEPTH) throw new Error("WebDAV XML 嵌套过深");
    if (depth < 0) throw new Error("WebDAV XML 结构无效");
  }
  if (depth !== 0) throw new Error("WebDAV XML 结构无效");
};

/**
 * 读取 HTTP 状态码
 * @param status - WebDAV propstat 状态行
 * @returns HTTP 状态码
 */
const getStatusCode = (status?: string): number => {
  const match = status?.match(/\s(\d{3})(?:\s|$)/);
  return match ? Number(match[1]) : 0;
};

/**
 * 解析 PROPFIND 多状态响应
 * @param xml - PROPFIND 响应正文
 * @param requestUrl - 当前请求地址
 * @param rootUrl - 配置根目录地址
 * @returns 已校验且合并成功属性的资源列表
 */
export const parsePropfind = (xml: string, requestUrl: URL, rootUrl: URL): WebDavResource[] => {
  if (!xml.trim()) throw new Error("WebDAV 返回了空 XML");
  if (FORBIDDEN_XML_PATTERN.test(xml)) throw new Error("WebDAV XML 包含 DTD 或实体声明");
  assertXmlDepth(xml);
  assertDavNamespace(xml);

  let document: { multistatus?: RawMultiStatus };
  try {
    document = parser.parse(xml) as { multistatus?: RawMultiStatus };
  } catch {
    throw new Error("WebDAV 返回了无效 XML");
  }
  const rawResponses = document.multistatus?.response;
  if (!rawResponses) throw new Error("WebDAV XML 缺少 multistatus 响应");

  return (Array.isArray(rawResponses) ? rawResponses : [rawResponses]).map((response) => {
    if (!response.href) throw new Error("WebDAV 资源缺少 href");
    const resolved = resolveWebDavHref(response.href, requestUrl, rootUrl);
    const propstats = response.propstat
      ? Array.isArray(response.propstat)
        ? response.propstat
        : [response.propstat]
      : [];
    const successful = propstats.filter((item) => getStatusCode(item.status) === 200);
    if (successful.length === 0) throw new Error("WebDAV 资源没有成功的 propstat");
    const properties = Object.assign({}, ...successful.map((item) => item.prop ?? {}));
    const contentLength = properties.getcontentlength
      ? Number(properties.getcontentlength)
      : undefined;
    return {
      href: resolved.url.href,
      path: resolved.path,
      relativePath: resolved.relativePath,
      isCollection:
        typeof properties.resourcetype === "object" &&
        properties.resourcetype !== null &&
        "collection" in properties.resourcetype,
      contentType: properties.getcontenttype,
      contentLength: Number.isFinite(contentLength) ? contentLength : undefined,
      lastModified: properties.getlastmodified,
      etag: properties.getetag,
    };
  });
};
