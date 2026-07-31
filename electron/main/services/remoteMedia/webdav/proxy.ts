import { createServer, type RequestListener, type Server } from "node:http";
import { pipeline } from "node:stream/promises";
import { request } from "undici";
import { createWebDavAuthorizationHeader } from "./client";
import { createWebDavResourceUrl, createWebDavRootUrl } from "./paths";
import type { WebDavRuntimeConfig } from "./types";

const TOKEN_TTL_MS = 30 * 60 * 1000;
const MAX_TOKENS = 256;

interface ProxyTarget {
  config: WebDavRuntimeConfig;
  relativePath: string;
  expiresAt: number;
}

const targets = new Map<string, ProxyTarget>();
let server: Server | null = null;
let port: number | null = null;

/** 清理过期和超量的代理 token */
const pruneTargets = (): void => {
  const now = Date.now();
  for (const [token, target] of targets) {
    if (target.expiresAt <= now) targets.delete(token);
  }
  while (targets.size >= MAX_TOKENS) {
    const oldest = targets.keys().next().value as string;
    targets.delete(oldest);
  }
};

/**
 * 转发一个 WebDAV 文件请求
 * @param incoming - loopback 客户端请求
 * @param response - loopback 客户端响应
 */
const handleProxyRequest: RequestListener = async (incoming, response) => {
  try {
    if (incoming.method !== "GET" && incoming.method !== "HEAD") {
      response.writeHead(405).end();
      return;
    }
    const token = new URL(incoming.url ?? "/", "http://127.0.0.1").pathname.slice(1);
    const target = targets.get(token);
    if (!target || target.expiresAt <= Date.now()) {
      targets.delete(token);
      response.writeHead(404).end();
      return;
    }
    const rootUrl = createWebDavRootUrl(target.config.url, target.config.rootPath ?? "/");
    const targetUrl = createWebDavResourceUrl(rootUrl, target.relativePath);
    const headers: Record<string, string> = {};
    for (const name of ["range", "if-range", "if-none-match", "if-modified-since"]) {
      const value = incoming.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    const authorization = createWebDavAuthorizationHeader(target.config);
    if (authorization) headers.Authorization = authorization;
    const upstream = await request(targetUrl, { method: incoming.method, headers });
    response.once("close", () => upstream.body.destroy());
    const responseHeaders: Record<string, string | string[]> = {};
    for (const name of [
      "accept-ranges",
      "cache-control",
      "content-length",
      "content-range",
      "content-type",
      "etag",
      "last-modified",
    ]) {
      const value = upstream.headers[name];
      if (value !== undefined) responseHeaders[name] = value;
    }
    response.writeHead(upstream.statusCode, responseHeaders);
    if (incoming.method === "HEAD") {
      await upstream.body.dump();
      response.end();
      return;
    }
    await pipeline(upstream.body, response);
  } catch {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  }
};

/**
 * 确保 loopback 代理已经启动
 * @returns 实际监听端口
 */
const ensureProxyServer = async (): Promise<number> => {
  if (server && port !== null) return port;
  server = createServer(handleProxyRequest);
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("WebDAV 播放代理启动失败");
  port = address.port;
  return port;
};

/**
 * 为 WebDAV 文件生成短期 loopback 播放地址
 * @param config - 主进程 WebDAV 配置
 * @param relativePath - 扫描得到的根目录相对路径
 * @returns 不包含来源信息和凭据的代理 URL
 */
export const createWebDavProxyUrl = async (
  config: WebDavRuntimeConfig,
  relativePath: string,
): Promise<string> => {
  const rootUrl = createWebDavRootUrl(config.url, config.rootPath ?? "/");
  createWebDavResourceUrl(rootUrl, relativePath);
  pruneTargets();
  const token = crypto.randomUUID().replaceAll("-", "");
  targets.set(token, { config, relativePath, expiresAt: Date.now() + TOKEN_TTL_MS });
  const proxyPort = await ensureProxyServer();
  return `http://127.0.0.1:${proxyPort}/${token}`;
};

/**
 * 立即失效指定来源的代理地址
 * @param sourceId - 来源 ID
 */
export const invalidateWebDavProxy = (sourceId: string): void => {
  for (const [token, target] of targets) {
    if (target.config.id === sourceId) targets.delete(token);
  }
};

/** 关闭 WebDAV loopback 代理 */
export const closeWebDavProxy = (): void => {
  targets.clear();
  server?.close();
  server = null;
  port = null;
};
