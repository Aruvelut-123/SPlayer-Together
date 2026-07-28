import type { StreamingServerConfig, StreamingServerType } from "@shared/types/streaming";
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
import { subsonicAdapter } from "./adapters/subsonic";
import { authenticate, jellyfinAdapter } from "./adapters/jellyfin";

const SUBSONIC_TYPES = new Set<StreamingServerType>([
  "subsonic",
  "navidrome",
  "opensubsonic",
  "airsonic",
  "gonic",
  "lms",
]);
const SONG_BATCH_SIZE = 500;
const runningServers = new Set<string>();

const syncServer = async (
  config: StreamingServerConfig,
  adapter: StreamingAdapter,
): Promise<void> => {
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
    while (true) {
      const songs = await adapter.listSongs(config, {
        offset: songCount,
        limit: SONG_BATCH_SIZE,
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
      if (songs.length < SONG_BATCH_SIZE) break;
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
  }
};

const resolveAdapter = async (
  config: StreamingServerConfig,
): Promise<{ config: StreamingServerConfig; adapter: StreamingAdapter } | null> => {
  if (SUBSONIC_TYPES.has(config.type)) return { config, adapter: subsonicAdapter };
  if (config.type === "jellyfin" || config.type === "emby") {
    const session = await authenticate(config);
    return { config: { ...config, ...session }, adapter: jellyfinAdapter };
  }
  return null;
};

/** 开发环境连接成功后启动不影响 renderer 的流媒体旁路同步 */
export const queueShadowSync = (config: StreamingServerConfig): void => {
  if (!isDev || runningServers.has(config.id)) return;
  if (!isDbOpen()) {
    streamingLog.warn(`数据库尚未初始化，跳过 Subsonic 旁路同步 [${config.name}]`);
    return;
  }
  runningServers.add(config.id);
  void resolveAdapter(config)
    .then((resolved) => (resolved ? syncServer(resolved.config, resolved.adapter) : undefined))
    .catch((error) => {
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
};
