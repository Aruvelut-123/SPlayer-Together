import { getDb } from "@main/database";
import type { RemoteSyncPhase, RemoteSyncState } from "@shared/types/streaming";

interface SyncStateRow {
  server_id: string;
  phase: RemoteSyncPhase;
  generation: number;
  cursor: string | null;
  discovered: number;
  completed: number;
  failed: number;
  started_at: number | null;
  completed_at: number | null;
  error: string | null;
}

/** 保存远程媒体同步状态 */
export const setSyncState = (state: RemoteSyncState): void => {
  getDb()
    .prepare(
      `INSERT INTO remote_sync_state (
        server_id, phase, generation, cursor, discovered, completed, failed,
        started_at, completed_at, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_id) DO UPDATE SET
        phase = excluded.phase,
        generation = excluded.generation,
        cursor = excluded.cursor,
        discovered = excluded.discovered,
        completed = excluded.completed,
        failed = excluded.failed,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        error = excluded.error`,
    )
    .run(
      state.serverId,
      state.phase,
      state.generation,
      state.cursor ?? null,
      state.discovered,
      state.completed,
      state.failed,
      state.startedAt ?? null,
      state.completedAt ?? null,
      state.error ?? null,
    );
};

/** 获取远程媒体同步状态 */
export const getSyncState = (serverId: string): RemoteSyncState => {
  const row = getDb()
    .prepare("SELECT * FROM remote_sync_state WHERE server_id = ?")
    .get(serverId) as SyncStateRow | undefined;
  if (!row) {
    return {
      serverId,
      phase: "idle",
      generation: 0,
      discovered: 0,
      completed: 0,
      failed: 0,
    };
  }
  return {
    serverId: row.server_id,
    phase: row.phase,
    generation: row.generation,
    cursor: row.cursor ?? undefined,
    discovered: row.discovered,
    completed: row.completed,
    failed: row.failed,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    error: row.error ?? undefined,
  };
};

/** 删除指定服务器的同步状态 */
export const deleteSyncState = (serverId: string): void => {
  getDb().prepare("DELETE FROM remote_sync_state WHERE server_id = ?").run(serverId);
};
