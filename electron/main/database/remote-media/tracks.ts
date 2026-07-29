import type { Track } from "@shared/types/player";
import { getDb } from "@main/database";

export interface RemoteTrackRecord {
  serverId: string;
  remoteId: string;
  track: Track;
  generation: number;
  relativePath?: string;
  etag?: string;
}

interface TrackRow {
  data: string;
}

/**
 * 批量写入远程歌曲
 * @param records - 远程歌曲记录
 */
export const upsertTracks = (records: RemoteTrackRecord[]): void => {
  if (records.length === 0) return;
  const statement = getDb().prepare(`
    INSERT INTO remote_tracks
      (server_id, remote_id, data, title, search_text, relative_path, etag, generation, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(server_id, remote_id) DO UPDATE SET
      data = excluded.data,
      title = excluded.title,
      search_text = excluded.search_text,
      relative_path = excluded.relative_path,
      etag = excluded.etag,
      generation = excluded.generation,
      updated_at = excluded.updated_at
  `);
  const now = Date.now();
  getDb().transaction(() => {
    for (const record of records) {
      const searchText = [
        record.track.title,
        record.track.album?.name,
        ...record.track.artists.map((artist) => artist.name),
      ]
        .filter(Boolean)
        .join("\n");
      statement.run(
        record.serverId,
        record.remoteId,
        JSON.stringify(record.track),
        record.track.title,
        searchText,
        record.relativePath ?? null,
        record.etag ?? null,
        record.generation,
        now,
      );
    }
  })();
};

/**
 * 获取指定服务器的完整歌曲列表
 * @param serverId - 服务器 ID
 * @returns 完整歌曲列表
 */
export const getTracks = (serverId: string): Track[] => {
  const rows = getDb()
    .prepare(
      "SELECT data FROM remote_tracks WHERE server_id = ? ORDER BY title COLLATE NOCASE, remote_id",
    )
    .all(serverId) as TrackRow[];
  return rows.map((row) => JSON.parse(row.data) as Track);
};

/**
 * 搜索指定服务器的歌曲
 * @param serverId - 服务器 ID
 * @param query - 搜索词
 * @returns 匹配的歌曲列表
 */
export const searchTracks = (serverId: string, query: string): Track[] => {
  const escaped = query
    .trim()
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
  if (!escaped) return [];
  const rows = getDb()
    .prepare(
      `SELECT data FROM remote_tracks
       WHERE server_id = ? AND search_text LIKE ? ESCAPE '\\'
       ORDER BY title COLLATE NOCASE, remote_id`,
    )
    .all(serverId, `%${escaped}%`) as TrackRow[];
  return rows.map((row) => JSON.parse(row.data) as Track);
};

/**
 * 删除指定服务器的旧同步数据
 * @param serverId - 服务器 ID
 * @param generation - 当前同步代次
 */
export const deleteStaleTracks = (serverId: string, generation: number): void => {
  getDb()
    .prepare("DELETE FROM remote_tracks WHERE server_id = ? AND generation <> ?")
    .run(serverId, generation);
};

/**
 * 删除指定服务器的全部歌曲
 * @param serverId - 服务器 ID
 */
export const deleteTracksByServer = (serverId: string): void => {
  getDb().prepare("DELETE FROM remote_tracks WHERE server_id = ?").run(serverId);
};
