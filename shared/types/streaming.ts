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
  /**
   * 读取服务器配置和当前激活项
   * @returns 运行时服务器配置与激活服务器 ID
   */
  loadServers: () => Promise<{
    servers: StreamingServerConfig[];
    activeServerId: string | null;
  }>;
  /**
   * 保存服务器配置和当前激活项
   * @param payload - 服务器配置与激活服务器 ID
   * @returns 保存完成
   */
  saveServers: (payload: {
    servers: StreamingServerConfig[];
    activeServerId: string | null;
  }) => Promise<void>;
  /**
   * 读取主进程 SQLite 媒体库快照
   * @param serverId - 服务器 ID
   * @returns 服务器的完整媒体库快照
   */
  getSnapshot: (serverId: string) => Promise<StreamingLibrarySnapshot>;
  /**
   * 读取后台同步状态
   * @param serverId - 服务器 ID
   * @returns 当前同步状态
   */
  getSyncState: (serverId: string) => Promise<RemoteSyncState>;
  /**
   * 启动后台同步
   * @param serverId - 服务器 ID
   * @param force - 是否忽略本次应用运行内的成功同步记录
   * @returns 是否启动了新任务
   */
  sync: (serverId: string, force?: boolean) => Promise<boolean>;
  /**
   * 搜索主进程 SQLite 中的远程媒体
   * @param serverId - 服务器 ID
   * @param query - 搜索关键词
   * @returns 歌曲、专辑和歌手搜索结果
   */
  search: (serverId: string, query: string) => Promise<StreamingSearchResult>;
  /**
   * 读取专辑歌曲
   * @param serverId - 服务器 ID
   * @param albumId - 服务端专辑 ID
   * @returns 专辑歌曲
   */
  getAlbumSongs: (serverId: string, albumId: string) => Promise<Track[]>;
  /**
   * 读取歌单歌曲
   * @param serverId - 服务器 ID
   * @param playlistId - 服务端歌单 ID
   * @returns 歌单歌曲
   */
  getPlaylistSongs: (serverId: string, playlistId: string) => Promise<Track[]>;
  /**
   * 读取歌手专辑
   * @param serverId - 服务器 ID
   * @param artistId - 服务端歌手 ID
   * @returns 歌手专辑
   */
  getArtistAlbums: (serverId: string, artistId: string) => Promise<Album[]>;
  /**
   * 读取歌手歌曲
   * @param serverId - 服务器 ID
   * @param artistId - 服务端歌手 ID
   * @returns 歌手歌曲
   */
  getArtistSongs: (serverId: string, artistId: string) => Promise<Track[]>;
}
