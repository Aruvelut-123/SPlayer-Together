import { createHash } from "node:crypto";
import type { StreamingServerConfig } from "@shared/types/streaming";
import { isDbOpen } from "@main/database";
import { upsertTracks, deleteStaleTracks } from "@main/database/remote-media/tracks";
import { upsertAlbums, deleteStaleAlbums } from "@main/database/remote-media/albums";
import { upsertArtists, deleteStaleArtists } from "@main/database/remote-media/artists";
import {
  cleanPlaylistTracks,
  deleteStalePlaylists,
  upsertPlaylists,
} from "@main/database/remote-media/playlists";
import { setSyncState } from "@main/database/remote-media/sync";
import { isDev } from "@main/utils/config";
import { streamingLog } from "@main/utils/logger";
import type { StreamingAdapter } from "./adapters/types";
import { resolveStreamingAdapter } from "./adapters/resolve";
const FIRST_SONG_BATCH_SIZE = 100;
const SONG_BATCH_SIZE = 500;
const runningServers = new Set<string>();
const syncedSignatures = new Map<string, string>();

/**
 * 生成不暴露凭据的同步配置签名
 * @param config - 主进程服务器配置
 * @returns 配置签名
 */
const getConfigSignature = (config: StreamingServerConfig): string =>
  createHash("sha256")
    .update([config.type, config.url, config.username, config.password].join("\0"))
    .digest("hex");

const syncServer = async (
  config: StreamingServerConfig,
  adapter: StreamingAdapter,
): Promise<boolean> => {
  const generation = Date.now();
  let songCount = 0;
  setSyncState({
    serverId: config.id,
    phase: "syncing",
    generation,
    discovered: 0,
    completed: 0,
    failed: 0,
    startedAt: generation,
  });
  try {
    let limit = FIRST_SONG_BATCH_SIZE;
    while (true) {
      const songs = await adapter.listSongs(config, {
        offset: songCount,
        limit,
      });
      upsertTracks(
        songs.map((track) => ({
          serverId: config.id,
          remoteId: track.originalId!,
          track,
          generation,
        })),
      );
      songCount += songs.length;
      setSyncState({
        serverId: config.id,
        phase: "syncing",
        generation,
        discovered: songCount,
        completed: songCount,
        failed: 0,
        startedAt: generation,
      });
      if (songs.length < limit) break;
      limit = SONG_BATCH_SIZE;
    }

    const albums = await adapter.listAlbums(config, { offset: 0, limit: 500 });
    upsertAlbums(
      albums.flatMap((album) =>
        album.id ? [{ serverId: config.id, remoteId: album.id, album, generation }] : [],
      ),
    );

    const artists = await adapter.listArtists(config);
    upsertArtists(
      artists.flatMap((artist) =>
        artist.id ? [{ serverId: config.id, remoteId: artist.id, artist, generation }] : [],
      ),
    );

    const playlists = await adapter.listPlaylists(config);
    upsertPlaylists(
      playlists.flatMap((playlist) =>
        playlist.id ? [{ serverId: config.id, remoteId: playlist.id, playlist, generation }] : [],
      ),
    );

    deleteStaleTracks(config.id, generation);
    deleteStaleAlbums(config.id, generation);
    deleteStaleArtists(config.id, generation);
    deleteStalePlaylists(config.id, generation);
    cleanPlaylistTracks(config.id);
    setSyncState({
      serverId: config.id,
      phase: "completed",
      generation,
      discovered: songCount,
      completed: songCount,
      failed: 0,
      startedAt: generation,
      completedAt: Date.now(),
    });
    streamingLog.info(
      `${config.type} 旁路同步完成 [${config.name}]: 歌曲 ${songCount}，专辑 ${albums.length}，歌手 ${artists.length}，歌单 ${playlists.length}`,
    );
    return true;
  } catch (error) {
    setSyncState({
      serverId: config.id,
      phase: "failed",
      generation,
      discovered: songCount,
      completed: songCount,
      failed: 1,
      startedAt: generation,
      completedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    });
    streamingLog.warn(`${config.type} 旁路同步失败 [${config.name}]:`, error);
    return false;
  }
};

/**
 * 启动开发环境后台流媒体同步
 * @param config - 服务器配置
 * @param force - 是否忽略本次应用运行内的成功同步记录
 * @returns 是否启动了新任务
 */
export const queueShadowSync = (config: StreamingServerConfig, force = false): boolean => {
  if (!isDev) return false;
  if (runningServers.has(config.id)) return false;
  const signature = getConfigSignature(config);
  if (!force && syncedSignatures.get(config.id) === signature) return false;
  if (!isDbOpen()) {
    streamingLog.warn(`数据库尚未初始化，跳过流媒体旁路同步 [${config.name}]`);
    return false;
  }
  runningServers.add(config.id);
  void resolveStreamingAdapter(config)
    .then((resolved) => syncServer(resolved.config, resolved.adapter))
    .then((success) => {
      if (success) syncedSignatures.set(config.id, signature);
      else syncedSignatures.delete(config.id);
    })
    .catch((error) => {
      syncedSignatures.delete(config.id);
      setSyncState({
        serverId: config.id,
        phase: "failed",
        generation: 0,
        discovered: 0,
        completed: 0,
        failed: 1,
        completedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      });
      streamingLog.warn(`${config.type} 旁路登录失败 [${config.name}]:`, error);
    })
    .finally(() => runningServers.delete(config.id));
  return true;
};
