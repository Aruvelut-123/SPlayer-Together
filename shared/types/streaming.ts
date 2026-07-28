import type { Album, Artist, Playlist, Track } from "./player";

/** 支持的流媒体服务器类型 */
export type StreamingServerType =
  | "subsonic"
  | "navidrome"
  | "opensubsonic"
  | "airsonic"
  | "gonic"
  | "lms"
  | "jellyfin"
  | "emby";

/**
 * 服务器配置
 */
export interface StreamingServerConfig {
  /** crypto.randomUUID() */
  id: string;
  name: string;
  type: StreamingServerType;
  /** 服务器地址，规范化为不带尾斜杠 */
  url: string;
  username: string;
  /** 明文密码 */
  password: string;
  /** Jellyfin/Emby 鉴权后回填 */
  accessToken?: string;
  /** Jellyfin/Emby 鉴权后回填的用户 ID */
  userId?: string;
  /** 最后一次连接成功的时间戳（ms） */
  lastConnected?: number;
}

/** 添加/编辑表单提交时的 payload */
export interface StreamingServerInput {
  name: string;
  type: StreamingServerType;
  url: string;
  username: string;
  password: string;
}

/** 错误归类 */
export type StreamingErrorCode = "auth" | "network" | "protocol" | "unknown";

/** 连通性测试结果 */
export interface StreamingPingResult {
  ok: boolean;
  /** 服务器版本号 */
  version?: string;
  /** 失败描述 */
  error?: string;
  /** 失败归类（仅 ok=false 时有意义） */
  code?: StreamingErrorCode;
}

/** Jellyfin/Emby 登录返回 */
export interface StreamingAuthResult {
  accessToken: string;
  userId: string;
}

/** 列表请求通用参数 */
export interface StreamingListParams {
  offset?: number;
  limit?: number;
}

/** 搜索结果聚合 */
export interface StreamingSearchResult {
  songs: Track[];
  albums: Album[];
  artists: Artist[];
}

export type RemoteSyncPhase = "idle" | "syncing" | "completed" | "partial" | "failed";

export interface RemoteSyncState {
  serverId: string;
  phase: RemoteSyncPhase;
  generation: number;
  cursor?: string;
  discovered: number;
  completed: number;
  failed: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

/** 主进程 SQLite 中一个远程服务器的完整媒体快照 */
export interface StreamingLibrarySnapshot {
  songs: Track[];
  albums: Album[];
  artists: Artist[];
  playlists: Playlist[];
  syncState: RemoteSyncState;
}

export interface StreamingApi {
  loadServers: () => Promise<{
    servers: StreamingServerConfig[];
    activeServerId: string | null;
  }>;
  saveServers: (payload: {
    servers: StreamingServerConfig[];
    activeServerId: string | null;
  }) => Promise<void>;
  /** 读取主进程 SQLite 快照 */
  getSnapshot: (serverId: string) => Promise<StreamingLibrarySnapshot>;
  /** 轻量读取后台同步状态 */
  getSyncState: (serverId: string) => Promise<RemoteSyncState>;
  /** 启动后台同步；force 仅供用户显式刷新 */
  sync: (serverId: string, force?: boolean) => Promise<boolean>;
  /** 搜索主进程 SQLite 中的远程媒体 */
  search: (serverId: string, query: string) => Promise<StreamingSearchResult>;
}
