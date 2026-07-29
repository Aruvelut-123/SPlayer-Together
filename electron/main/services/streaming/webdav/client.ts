import { request } from "undici";
import type { StreamingAdapter } from "../adapters/types";
import type { StreamingRuntimeConfig } from "@shared/types/streaming";
import type { StreamingPingResult } from "@shared/types/streaming";
import { parsePropfind } from "./parser";
import { normalizeUrl, normalizePath } from "./paths";

/**
 * 构建带认证的请求头
 * @param config - 主进程服务器配置
 * @param extraHeaders - 额外的请求头
 * @returns 包含认证信息的请求头对象
 */
const buildHeaders = (config: StreamingRuntimeConfig, extraHeaders?: Record<string, string>) => {
  const headers: Record<string, string> = { ...extraHeaders };
  if (config.password || config.username) {
    const token = Buffer.from(`${config.username}:${config.password}`).toString("base64");
    headers["Authorization"] = `Basic ${token}`;
  }
  return headers;
};

/**
 * 测试 WebDAV 连接
 * @param config - 主进程服务器配置
 * @returns 连通性测试结果
 */
const pingWebDav = async (config: StreamingRuntimeConfig): Promise<StreamingPingResult> => {
  if (config.type !== "webdav") throw new Error("Invalid config type for WebDAV");
  const baseUrl = normalizeUrl(config.url);
  const rootPath = normalizePath(config.rootPath || "/");
  const fullUrl = `${baseUrl}${rootPath}`;

  try {
    let res = await request(fullUrl, {
      method: "PROPFIND",
      headers: buildHeaders(config, { Depth: "0" }),
    });

    if (res.statusCode === 405 || res.statusCode === 501) {
      res = await request(fullUrl, {
        method: "PROPFIND",
        headers: buildHeaders(config, { Depth: "1" }),
      });
    }

    if (res.statusCode === 401 || res.statusCode === 403) {
      return { ok: false, error: `鉴权失败: ${res.statusCode}`, code: "auth" };
    }
    if (res.statusCode === 404) {
      return { ok: false, error: `路径不存在: ${res.statusCode}`, code: "network" };
    }
    if (res.statusCode !== 200 && res.statusCode !== 207) {
      return { ok: false, error: `HTTP ${res.statusCode}`, code: "protocol" };
    }

    const xmlText = await res.body.text();
    parsePropfind(xmlText, rootPath);

    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message, code: "network" };
  }
};

/**
 * 占位符方法：未实现的 WebDAV 适配器接口
 * @param methodName - 方法名称
 * @returns 总是抛出异常的异步方法
 */
const throwNotImplemented = (methodName: string) => {
  return async (): Promise<any> => {
    throw new Error(`WebDAV adapter ${methodName} is not implemented for WebDAV yet.`);
  };
};

/**
 * 暴露给外部的 WebDAV Dummy Adapter，目前仅实现 ping
 */
export const webdavAdapter: StreamingAdapter = {
  ping: pingWebDav,
  listSongs: throwNotImplemented("listSongs"),
  listAlbums: throwNotImplemented("listAlbums"),
  listArtists: throwNotImplemented("listArtists"),
  listPlaylists: throwNotImplemented("listPlaylists"),
  getAlbumSongs: throwNotImplemented("getAlbumSongs"),
  getPlaylistSongs: throwNotImplemented("getPlaylistSongs"),
  getArtistAlbums: throwNotImplemented("getArtistAlbums"),
  getArtistSongs: throwNotImplemented("getArtistSongs"),
  getStreamUrl: throwNotImplemented("getStreamUrl"),
  getLyrics: throwNotImplemented("getLyrics"),
  getCoverUrl: throwNotImplemented("getCoverUrl"),
};
