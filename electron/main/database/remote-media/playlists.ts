import type { Playlist } from "@shared/types/player";
import { getDb } from "@main/database";

export interface RemotePlaylistRecord {
  serverId: string;
  remoteId: string;
  playlist: Playlist;
  generation: number;
}

interface PlaylistRow {
  data: string;
}

/** 批量写入远程歌单 */
export const upsertPlaylists = (records: RemotePlaylistRecord[]): void => {
  if (records.length === 0) return;
  const statement = getDb().prepare(`
    INSERT INTO remote_playlists (server_id, remote_id, data, name, generation, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(server_id, remote_id) DO UPDATE SET
      data = excluded.data,
      name = excluded.name,
      generation = excluded.generation,
      updated_at = excluded.updated_at
  `);
  const now = Date.now();
  getDb().transaction(() => {
    for (const record of records) {
      statement.run(
        record.serverId,
        record.remoteId,
        JSON.stringify(record.playlist),
        record.playlist.name,
        record.generation,
        now,
      );
    }
  })();
};

/** 获取指定服务器的完整歌单列表 */
export const getPlaylists = (serverId: string): Playlist[] => {
  const rows = getDb()
    .prepare(
      "SELECT data FROM remote_playlists WHERE server_id = ? ORDER BY name COLLATE NOCASE, remote_id",
    )
    .all(serverId) as PlaylistRow[];
  return rows.map((row) => JSON.parse(row.data) as Playlist);
};

/** 覆盖一个远程歌单的歌曲顺序 */
export const replacePlaylistTracks = (
  serverId: string,
  playlistId: string,
  trackIds: string[],
): void => {
  const remove = getDb().prepare(
    "DELETE FROM remote_playlist_tracks WHERE server_id = ? AND playlist_id = ?",
  );
  const insert = getDb().prepare(`
    INSERT INTO remote_playlist_tracks (server_id, playlist_id, track_id, position)
    VALUES (?, ?, ?, ?)
  `);
  getDb().transaction(() => {
    remove.run(serverId, playlistId);
    trackIds.forEach((trackId, position) => insert.run(serverId, playlistId, trackId, position));
  })();
};

/** 获取远程歌单的歌曲 ID 列表 */
export const getPlaylistTrackIds = (serverId: string, playlistId: string): string[] => {
  const rows = getDb()
    .prepare(
      `SELECT track_id FROM remote_playlist_tracks
       WHERE server_id = ? AND playlist_id = ?
       ORDER BY position`,
    )
    .all(serverId, playlistId) as { track_id: string }[];
  return rows.map((row) => row.track_id);
};

/** 删除指定服务器的旧同步歌单 */
export const deleteStalePlaylists = (serverId: string, generation: number): void => {
  getDb().transaction(() => {
    getDb()
      .prepare("DELETE FROM remote_playlists WHERE server_id = ? AND generation <> ?")
      .run(serverId, generation);
    getDb()
      .prepare(
        `DELETE FROM remote_playlist_tracks
         WHERE server_id = ? AND playlist_id NOT IN (
           SELECT remote_id FROM remote_playlists WHERE server_id = ?
         )`,
      )
      .run(serverId, serverId);
  })();
};

/** 清理已经不存在的歌单或歌曲关系 */
export const cleanPlaylistTracks = (serverId: string): void => {
  getDb()
    .prepare(
      `DELETE FROM remote_playlist_tracks
       WHERE server_id = ? AND (
         playlist_id NOT IN (
           SELECT remote_id FROM remote_playlists WHERE server_id = ?
         ) OR track_id NOT IN (
           SELECT remote_id FROM remote_tracks WHERE server_id = ?
         )
       )`,
    )
    .run(serverId, serverId, serverId);
};

/** 删除指定服务器的全部歌单 */
export const deletePlaylistsByServer = (serverId: string): void => {
  getDb().transaction(() => {
    getDb().prepare("DELETE FROM remote_playlist_tracks WHERE server_id = ?").run(serverId);
    getDb().prepare("DELETE FROM remote_playlists WHERE server_id = ?").run(serverId);
  })();
};
