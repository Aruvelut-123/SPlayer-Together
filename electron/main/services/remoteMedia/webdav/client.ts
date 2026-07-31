import { request, type Dispatcher } from "undici";
import { isWebDavAudioFilename } from "./extensions";
import { createWebDavRootUrl } from "./paths";
import { parsePropfind, type WebDavResource } from "./parser";
import type { WebDavConnectionResult, WebDavRuntimeConfig } from "./types";

const MAX_REDIRECTS = 5;
const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontenttype/><d:getcontentlength/><d:getlastmodified/><d:getetag/></d:prop></d:propfind>`;

interface WebDavRequestOptions {
  method: Dispatcher.HttpMethod;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * 构建 WebDAV Basic 鉴权请求头
 * @param config - WebDAV 来源配置
 * @returns 不向 renderer 暴露的鉴权请求头
 */
export const createWebDavAuthorizationHeader = (
  config: WebDavRuntimeConfig,
): string | undefined => {
  if (!config.username && !config.password) return undefined;
  return `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
};

/**
 * 发起只允许同源跳转的 WebDAV 请求
 * @param url - 请求地址
 * @param options - undici 请求参数
 * @param authorization - Basic 鉴权头
 * @returns 最终响应及地址
 */
const requestSameOrigin = async (
  url: URL,
  options: WebDavRequestOptions,
  authorization?: string,
): Promise<{ response: Dispatcher.ResponseData; url: URL }> => {
  const origin = url.origin;
  let currentUrl = url;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const headers = { ...(options.headers as Record<string, string> | undefined) };
    if (authorization) headers.Authorization = authorization;
    const response = await request(currentUrl, { ...options, headers });
    if (![301, 302, 303, 307, 308].includes(response.statusCode)) {
      return { response, url: currentUrl };
    }
    const location = response.headers.location;
    await response.body.dump();
    if (!location) throw new Error("WebDAV 重定向缺少 Location");
    const redirected = new URL(Array.isArray(location) ? location[0] : location, currentUrl);
    if (redirected.origin !== origin) throw new Error("WebDAV 不允许跨域重定向");
    currentUrl = redirected;
  }
  throw new Error("WebDAV 重定向次数过多");
};

/**
 * 将 WebDAV 状态码转换为连接测试结果
 * @param statusCode - HTTP 状态码
 * @returns 失败结果，成功状态返回 null
 */
const statusFailure = (statusCode: number): WebDavConnectionResult | null => {
  if (statusCode === 401 || statusCode === 403) {
    return { ok: false, error: `鉴权失败: HTTP ${statusCode}`, code: "auth" };
  }
  if (statusCode === 404) {
    return { ok: false, error: "WebDAV 根目录不存在", code: "not_found" };
  }
  if (statusCode === 405 || statusCode === 501) {
    return { ok: false, error: "服务器不支持 WebDAV PROPFIND", code: "protocol" };
  }
  return null;
};

/**
 * 枚举 WebDAV 目录
 * @param config - WebDAV 来源配置
 * @param url - 目录请求地址
 * @param rootUrl - 配置根目录地址
 * @param depth - PROPFIND 深度
 * @returns 状态码和已校验的资源列表
 */
const propfind = async (
  config: WebDavRuntimeConfig,
  url: URL,
  rootUrl: URL,
  depth: 0 | 1,
): Promise<{ statusCode: number; resources: WebDavResource[] }> => {
  const authorization = createWebDavAuthorizationHeader(config);
  const { response, url: responseUrl } = await requestSameOrigin(
    url,
    {
      method: "PROPFIND",
      headers: { Depth: String(depth), "Content-Type": "application/xml; charset=utf-8" },
      body: PROPFIND_BODY,
    },
    authorization,
  );
  if (response.statusCode !== 200 && response.statusCode !== 207) {
    await response.body.dump();
    return { statusCode: response.statusCode, resources: [] };
  }
  const xml = await response.body.text();
  return {
    statusCode: response.statusCode,
    resources: parsePropfind(xml, responseUrl, rootUrl),
  };
};

/**
 * 判断资源是否为受支持的音频文件
 * @param resource - WebDAV 文件资源
 * @returns 是否可以进入媒体扫描
 */
const isAudioResource = (resource: WebDavResource): boolean => {
  if (resource.isCollection) return false;
  return isWebDavAudioFilename(resource.relativePath);
};

/**
 * 读取 WebDAV 单层目录
 * @param config - WebDAV 来源配置
 * @param directoryUrl - 待枚举目录地址
 * @param rootUrl - 配置根目录地址
 * @returns 已校验且不包含目录自身的子资源
 */
export const listWebDavDirectory = async (
  config: WebDavRuntimeConfig,
  directoryUrl: URL,
  rootUrl: URL,
): Promise<WebDavResource[]> => {
  const result = await propfind(config, directoryUrl, rootUrl, 1);
  const failure = statusFailure(result.statusCode);
  if (failure) throw new Error(failure.error);
  if (result.statusCode !== 200 && result.statusCode !== 207) {
    throw new Error(`PROPFIND 请求失败: HTTP ${result.statusCode}`);
  }
  const directoryPath = directoryUrl.pathname.replace(/\/+$/, "") || "/";
  return result.resources.filter(
    (resource) => (new URL(resource.href).pathname.replace(/\/+$/, "") || "/") !== directoryPath,
  );
};

/**
 * 验证文件是否支持 Range 播放
 * @param config - WebDAV 来源配置
 * @param resource - 待验证的首个音频资源
 * @returns 播放能力测试结果
 */
const verifyRangeSupport = async (
  config: WebDavRuntimeConfig,
  resource: WebDavResource,
): Promise<WebDavConnectionResult> => {
  const authorization = createWebDavAuthorizationHeader(config);
  const target = new URL(resource.href);
  const head = await requestSameOrigin(target, { method: "HEAD" }, authorization);
  const headFailure = statusFailure(head.response.statusCode);
  await head.response.body.dump();
  if (headFailure) return headFailure;
  if (head.response.statusCode < 200 || head.response.statusCode >= 400) {
    return {
      ok: false,
      error: `音频 HEAD 请求失败: HTTP ${head.response.statusCode}`,
      code: "protocol",
    };
  }

  const ranged = await requestSameOrigin(
    target,
    { method: "GET", headers: { Range: "bytes=0-0" } },
    authorization,
  );
  const rangeFailure = statusFailure(ranged.response.statusCode);
  if (rangeFailure) {
    await ranged.response.body.dump();
    return rangeFailure;
  }
  const contentRange = ranged.response.headers["content-range"];
  await ranged.response.body.dump();
  if (
    ranged.response.statusCode !== 206 ||
    typeof contentRange !== "string" ||
    !/^bytes 0-0\/\d+$/.test(contentRange)
  ) {
    return { ok: false, error: "服务器未正确响应 Range: bytes=0-0", code: "protocol" };
  }
  return { ok: true, playbackVerified: true };
};

/**
 * 测试 WebDAV 目录访问与 Range 播放能力
 * @param config - WebDAV 来源配置
 * @returns 连通性测试结果
 */
export const testWebDavConnection = async (
  config: WebDavRuntimeConfig,
): Promise<WebDavConnectionResult> => {
  try {
    const rootUrl = createWebDavRootUrl(config.url, config.rootPath ?? "/");
    let rootResult = await propfind(config, rootUrl, rootUrl, 0);
    if (rootResult.statusCode === 405 || rootResult.statusCode === 501) {
      rootResult = await propfind(config, rootUrl, rootUrl, 1);
    }
    const rootFailure = statusFailure(rootResult.statusCode);
    if (rootFailure) return rootFailure;
    if (rootResult.statusCode !== 200 && rootResult.statusCode !== 207) {
      return {
        ok: false,
        error: `PROPFIND 请求失败: HTTP ${rootResult.statusCode}`,
        code: "protocol",
      };
    }
    const rootPath = rootUrl.pathname.replace(/\/+$/, "") || "/";
    const root = rootResult.resources.find(
      (resource) => (new URL(resource.href).pathname.replace(/\/+$/, "") || "/") === rootPath,
    );
    if (!root?.isCollection) {
      return { ok: false, error: "WebDAV 根路径不是目录", code: "protocol" };
    }

    const directory = rootResult.resources.some((resource) => resource.relativePath)
      ? rootResult
      : await propfind(config, rootUrl, rootUrl, 1);
    const directoryFailure = statusFailure(directory.statusCode);
    if (directoryFailure) return directoryFailure;
    const audio = directory.resources.find(isAudioResource);
    if (!audio) {
      return {
        ok: true,
        playbackVerified: false,
        warning: "目录可访问，尚未找到可验证播放的音频文件",
      };
    }
    return verifyRangeSupport(config, audio);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = /XML|href|路径|跨域|Range|重定向|资源地址/i.test(message) ? "protocol" : "network";
    return { ok: false, error: message, code };
  }
};
