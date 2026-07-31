import fs from "node:fs";
import path from "node:path";
import { safeStorage } from "electron";
import { writeFileSync as atomicWriteSync } from "atomically";
import type { WebDavPlaylistInput } from "@shared/types/playlist";
import { configDir } from "@main/utils/paths";
import { normalizeWebDavBaseUrl, normalizeWebDavRootPath } from "./webdav/paths";
import type { WebDavRuntimeConfig } from "./webdav/types";

const STORAGE_FILE = path.join(configDir, "remote-media.json");

interface PersistedWebDavConfig {
  playlistId: string;
  url: string;
  username: string;
  encryptedPassword: string;
  rootPath: string;
  scanDepth: number;
}

let configs: PersistedWebDavConfig[] | undefined;

/** 读取远程歌单配置 */
const getConfigs = (): PersistedWebDavConfig[] => {
  if (configs) return configs;
  try {
    const parsed = JSON.parse(fs.readFileSync(STORAGE_FILE, "utf-8")) as unknown;
    configs = Array.isArray(parsed) ? (parsed as PersistedWebDavConfig[]) : [];
  } catch {
    configs = [];
  }
  return configs;
};

/** 保存远程歌单配置 */
const save = (): void => {
  fs.mkdirSync(configDir, { recursive: true });
  atomicWriteSync(STORAGE_FILE, JSON.stringify(getConfigs(), null, 2));
};

/** 保存 WebDAV 歌单配置 */
export const addWebDavPlaylistConfig = (playlistId: string, input: WebDavPlaylistInput): void => {
  if (!Number.isInteger(input.scanDepth) || input.scanDepth < 0 || input.scanDepth > 10) {
    throw new Error("WebDAV 扫描深度无效");
  }
  const url = normalizeWebDavBaseUrl(input.url.trim()).toString().replace(/\/$/, "");
  const rootPath = normalizeWebDavRootPath(input.rootPath);
  const password = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(input.password).toString("base64")
    : Buffer.from(input.password, "utf-8").toString("base64");
  getConfigs().push({
    playlistId,
    url,
    username: input.username,
    encryptedPassword: password,
    rootPath,
    scanDepth: input.scanDepth,
  });
  save();
};

/** 删除远程歌单配置 */
export const removeWebDavPlaylistConfig = (playlistId: string): void => {
  const current = getConfigs();
  const next = current.filter((config) => config.playlistId !== playlistId);
  if (next.length === current.length) return;
  configs = next;
  save();
};

/** 清空远程歌单配置 */
export const clearRemoteMediaConfig = (): void => {
  if (getConfigs().length === 0) return;
  configs = [];
  save();
};

/** 获取 WebDAV 运行时配置 */
export const getWebDavPlaylistConfig = (playlistId: string, name: string): WebDavRuntimeConfig => {
  const config = getConfigs().find((item) => item.playlistId === playlistId);
  if (!config) throw new Error("找不到 WebDAV 歌单配置");
  const encrypted = Buffer.from(config.encryptedPassword, "base64");
  return {
    id: playlistId,
    name,
    url: config.url,
    username: config.username,
    password: safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(encrypted)
      : encrypted.toString("utf-8"),
    rootPath: config.rootPath,
    scanDepth: config.scanDepth,
  };
};
