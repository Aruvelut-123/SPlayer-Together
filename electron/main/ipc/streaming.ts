/**
 * 流媒体相关 IPC：
 * - loadServers / saveServers：服务器配置持久化
 */
import fs from "node:fs";
import path from "node:path";
import { ipcMain, safeStorage } from "electron";
import { writeFileSync as atomicWriteSync } from "atomically";
import { streamingLog } from "@main/utils/logger";
import { configDir } from "@main/utils/paths";
import type { StreamingServerConfig } from "@shared/types/streaming";
import { queueShadowSync } from "@main/services/streaming/shadowSync";
import {
  getLibrarySnapshot,
  getLibrarySyncState,
  searchLibrary,
} from "@main/services/streaming/library";
import { resolveStreamingAdapter } from "@main/services/streaming/adapters/resolve";
import type { StreamingAdapter } from "@main/services/streaming/adapters/types";

const STORAGE_FILE = path.join(configDir, "streaming.json");

/** 持久化形态：密码加密、accessToken/userId 不持久化（每次会话重新登录） */
interface PersistedServer extends Omit<
  StreamingServerConfig,
  "password" | "accessToken" | "userId"
> {
  encryptedPassword: string;
}

interface PersistedState {
  servers: PersistedServer[];
  activeServerId: string | null;
}

const readPersisted = (): PersistedState => {
  try {
    const raw = JSON.parse(fs.readFileSync(STORAGE_FILE, "utf-8")) as PersistedState;
    if (!Array.isArray(raw?.servers)) return { servers: [], activeServerId: null };
    return { servers: raw.servers, activeServerId: raw.activeServerId ?? null };
  } catch {
    return { servers: [], activeServerId: null };
  }
};

const writePersisted = (data: PersistedState): void => {
  try {
    const dir = path.dirname(STORAGE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    atomicWriteSync(STORAGE_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    streamingLog.error("写入 streaming.json 失败:", err);
  }
};

/**
 * 加密密码
 * @param plain 明文密码
 * @returns 加密后的密码
 */
const encryptPassword = (plain: string): string => {
  if (!plain) return "";
  if (!safeStorage.isEncryptionAvailable()) {
    streamingLog.warn("系统安全存储不可用（缺少 keyring），流媒体密码将以 base64 形式明文落盘");
    return Buffer.from(plain, "utf-8").toString("base64");
  }
  return safeStorage.encryptString(plain).toString("base64");
};

/**
 * 解密密码
 * @param encrypted 加密后的密码
 * @returns 明文密码
 */
const decryptPassword = (encrypted: string): string => {
  if (!encrypted) return "";
  try {
    const buf = Buffer.from(encrypted, "base64");
    if (!safeStorage.isEncryptionAvailable()) {
      return buf.toString("utf-8");
    }
    return safeStorage.decryptString(buf);
  } catch {
    return "";
  }
};

const toRuntimeConfig = (server: PersistedServer): StreamingServerConfig => ({
  id: server.id,
  name: server.name,
  type: server.type,
  url: server.url,
  username: server.username,
  password: decryptPassword(server.encryptedPassword),
  lastConnected: server.lastConnected,
});

/**
 * 从加密配置加载服务器，并使用对应主进程适配器执行请求
 * @param serverId - 服务器 ID
 * @param request - 使用已鉴权配置和适配器执行的请求
 * @returns 请求结果
 */
const withServerAdapter = async <T>(
  serverId: string,
  request: (config: StreamingServerConfig, adapter: StreamingAdapter) => Promise<T>,
): Promise<T> => {
  const server = readPersisted().servers.find((item) => item.id === serverId);
  if (!server) throw new Error("找不到流媒体服务器");
  const resolved = await resolveStreamingAdapter(toRuntimeConfig(server));
  return request(resolved.config, resolved.adapter);
};

export const registerStreamingIpc = (): void => {
  ipcMain.handle("streaming:loadServers", () => {
    const persisted = readPersisted();
    const servers = persisted.servers.map(toRuntimeConfig);
    return { servers, activeServerId: persisted.activeServerId };
  });

  ipcMain.handle(
    "streaming:saveServers",
    (_e, payload: { servers: StreamingServerConfig[]; activeServerId: string | null }): void => {
      const previous = readPersisted();
      const previousConnectedAt = new Map(
        previous.servers.map((server) => [server.id, server.lastConnected] as const),
      );
      const servers: PersistedServer[] = (payload?.servers ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type,
        url: s.url,
        username: s.username,
        encryptedPassword: encryptPassword(s.password),
        lastConnected: s.lastConnected,
      }));
      writePersisted({ servers, activeServerId: payload?.activeServerId ?? null });
      for (const server of payload?.servers ?? []) {
        if (server.lastConnected && server.lastConnected !== previousConnectedAt.get(server.id)) {
          queueShadowSync(server);
        }
      }
    },
  );

  ipcMain.handle("streaming:getSnapshot", (_event, serverId: string) => {
    const exists = readPersisted().servers.some((server) => server.id === serverId);
    if (!exists) throw new Error("找不到流媒体服务器");
    return getLibrarySnapshot(serverId);
  });

  ipcMain.handle("streaming:getSyncState", (_event, serverId: string) => {
    const exists = readPersisted().servers.some((server) => server.id === serverId);
    if (!exists) throw new Error("找不到流媒体服务器");
    return getLibrarySyncState(serverId);
  });

  ipcMain.handle("streaming:sync", (_event, serverId: string, force = false): boolean => {
    const server = readPersisted().servers.find((item) => item.id === serverId);
    if (!server) throw new Error("找不到流媒体服务器");
    return queueShadowSync(toRuntimeConfig(server), force);
  });

  ipcMain.handle("streaming:search", (_event, serverId: string, query: string) => {
    const exists = readPersisted().servers.some((server) => server.id === serverId);
    if (!exists) throw new Error("找不到流媒体服务器");
    return searchLibrary(serverId, query.slice(0, 200));
  });

  ipcMain.handle("streaming:getAlbumSongs", (_event, serverId: string, albumId: string) =>
    withServerAdapter(serverId, (config, adapter) => adapter.getAlbumSongs(config, albumId)),
  );

  ipcMain.handle("streaming:getPlaylistSongs", (_event, serverId: string, playlistId: string) =>
    withServerAdapter(serverId, (config, adapter) => adapter.getPlaylistSongs(config, playlistId)),
  );

  ipcMain.handle("streaming:getArtistAlbums", (_event, serverId: string, artistId: string) =>
    withServerAdapter(serverId, (config, adapter) => adapter.getArtistAlbums(config, artistId)),
  );

  ipcMain.handle("streaming:getArtistSongs", (_event, serverId: string, artistId: string) =>
    withServerAdapter(serverId, (config, adapter) => adapter.getArtistSongs(config, artistId)),
  );
};
