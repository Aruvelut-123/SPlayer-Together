import { XMLParser } from "fast-xml-parser";
import { normalizePath } from "./paths";

export interface WebDavPropStat {
  status: string;
  prop: {
    resourcetype?: { collection?: string | object | null };
    getcontenttype?: string;
    getcontentlength?: number;
    getlastmodified?: string;
  };
}

export interface WebDavResponseItem {
  href: string;
  propstat: WebDavPropStat | WebDavPropStat[];
}

export interface WebDavMultiStatus {
  response?: WebDavResponseItem | WebDavResponseItem[];
}

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true, // 忽略 ns0, d 等命名空间前缀
  trimValues: true,
  parseTagValue: false,
});

/**
 * 安全解析 XML
 * @param xmlString - 原始 XML 字符串
 * @returns 解析后的多状态响应对象，若解析失败则返回 null
 */
export const parseXml = (xmlString: string): WebDavMultiStatus | null => {
  if (!xmlString || typeof xmlString !== "string") return null;
  // 简单防护 DTD 和 ENTITY (fast-xml-parser 默认不支持外部实体，但保险起见拒绝 DOCTYPE)
  if (xmlString.includes("<!DOCTYPE") || xmlString.includes("<!ENTITY")) {
    throw new Error("XML 包含非法内容 (DOCTYPE/ENTITY)");
  }

  try {
    const result = parser.parse(xmlString);
    return result.multistatus ?? null;
  } catch {
    return null;
  }
};

/**
 * 解析 PROPFIND 结果
 * @param xmlString - PROPFIND 请求返回的 XML 字符串
 * @param basePath - 请求的根目录路径，用于过滤自身
 * @returns WebDAV 响应项数组
 */
export const parsePropfind = (xmlString: string, basePath: string): WebDavResponseItem[] => {
  const multiStatus = parseXml(xmlString);
  if (!multiStatus || !multiStatus.response) return [];

  const responses = Array.isArray(multiStatus.response)
    ? multiStatus.response
    : [multiStatus.response];

  const normalizedBasePath = normalizePath(basePath);

  return responses.filter((item) => {
    if (!item.href) return false;
    let decodedHref = "";
    try {
      decodedHref = decodeURIComponent(item.href);
    } catch {
      decodedHref = item.href;
    }
    const itemPath = normalizePath(decodedHref);
    // 过滤掉目录自身
    if (itemPath === normalizedBasePath) return false;
    return true;
  });
};
