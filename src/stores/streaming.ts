import localforage from "localforage";
import type { Album, Artist, Playlist, Track } from "@shared/types/player";
import type {
  StreamingErrorCode,
  StreamingListParams,
  StreamingPingResult,
  StreamingSearchResult,
  StreamingLibrarySnapshot,
  StreamingServerConfig,
  StreamingServerInput,
  StreamingServerType,
} from "@shared/types/streaming";
import * as client from "@/services/streaming";
import * as session from "@/services/streaming/session";
import { StreamingAuthError, classifyError } from "@/services/streaming/errors";

const NEEDS_AUTH: StreamingServerType[] = ["jellyfin", "emby"];
const needsAccessToken = (type: StreamingServerType): boolean => NEEDS_AUTH.includes(type);

/** 浏览缓存 */
interface ServerCache {
  songs: Track[];
  albums: Album[];
  artists: Artist[];
  playlists: Playlist[];
  /** 最后更新时间 */
  updatedAt: number;
}

const cacheDb = localforage.createInstance({ name: "splayer", storeName: "streaming-cache" });
const cacheKey = (serverId: string): string => `cache:${serverId}`;

export const useStreamingStore = defineStore("streaming", () => {
  /** 服务器列表 */
  const servers = ref<StreamingServerConfig[]>([]);
  /** 当前激活服务器 ID */
  const activeServerId = ref<string | null>(null);
  /** 连接状态（仅运行时） */
  const connectionStatus = ref<{
    connected: boolean;
    error?: string;
    errorCode?: StreamingErrorCode;
  }>({ connected: false });
  /** 是否正在拉数据（首次加载/刷新；后台分批继续拉时仍为 false，UI 不再阻塞） */
  const loading = ref(false);

  /** 运行时缓存 */
  const songs = shallowRef<Track[]>([]);
  const albums = shallowRef<Album[]>([]);
  const artists = shallowRef<Artist[]>([]);
  const playlists = shallowRef<Playlist[]>([]);
  /** 缓存最后更新时间（ms） */
  const lastFetchedAt = ref(0);
  /** 是否已从 IndexedDB 完成首次水合 */
  const hydrated = ref(false);

  const activeServer = computed<StreamingServerConfig | null>(
    () => servers.value.find((s) => s.id === activeServerId.value) ?? null,
  );
  const hasServer = computed(() => servers.value.length > 0);
  const isConnected = computed(() => connectionStatus.value.connected);

  /** 把 servers + activeServerId 写到主进程 */
  const persistServers = (): void => {
    void window.api.streaming.saveServers({
      servers: servers.value.map((s) => ({ ...s })),
      activeServerId: activeServerId.value,
    });
  };

  const currentCacheKey = (): string | null =>
    activeServerId.value ? cacheKey(activeServerId.value) : null;

  /** 用当前 cfg 凭据为内存中的 cover/avatar URL 重新贴上鉴权 */
  const refreshCoverUrlsForActive = (): void => {
    const cfg = activeServer.value;
    if (!cfg) return;
    songs.value = songs.value.map((track) =>
      track.cover ? { ...track, cover: client.refreshCoverAuth(track.cover, cfg) } : track,
    );
    albums.value = albums.value.map((album) =>
      album.cover ? { ...album, cover: client.refreshCoverAuth(album.cover, cfg) } : album,
    );
    artists.value = artists.value.map((artist) =>
      artist.avatar ? { ...artist, avatar: client.refreshCoverAuth(artist.avatar, cfg) } : artist,
    );
    playlists.value = playlists.value.map((playlist) =>
      playlist.cover
        ? { ...playlist, cover: client.refreshCoverAuth(playlist.cover, cfg) }
        : playlist,
    );
  };

  const clearMemoryLists = (): void => {
    songs.value = [];
    albums.value = [];
    artists.value = [];
    playlists.value = [];
    lastFetchedAt.value = 0;
  };

  const hydrateFromCache = async (): Promise<void> => {
    const key = currentCacheKey();
    if (!key) {
      clearMemoryLists();
      hydrated.value = true;
      return;
    }
    const cached = await cacheDb.getItem<ServerCache>(key).catch(() => null);
    // 竞态保护：await 期间用户可能已切到其它服务器，丢弃过期结果
    if (key !== currentCacheKey()) return;
    if (cached) {
      songs.value = cached.songs;
      albums.value = cached.albums;
      artists.value = cached.artists;
      playlists.value = cached.playlists;
      lastFetchedAt.value = cached.updatedAt;
      // Subsonic 此时已有密码，覆盖鉴权立即生效；Jellyfin/Emby 缺 token 则仅剥离，
      // 待 connectToServer 成功再贴一次（防御性：旧版本可能落盘了带 api_key 的 URL）
      refreshCoverUrlsForActive();
    } else {
      clearMemoryLists();
    }
    hydrated.value = true;
  };

  const normalizeUrl = (url: string): string => url.trim().replace(/\/+$/, "");

  /**
   * 把 patch 合并到指定 server 并落盘
   * @param id - 目标 server id
   * @param patch - 要合并的字段子集
   */
  const patchServer = (id: string, patch: Partial<StreamingServerConfig>): void => {
    const idx = servers.value.findIndex((s) => s.id === id);
    if (idx < 0) return;
    const next = [...servers.value];
    next[idx] = { ...next[idx], ...patch };
    servers.value = next;
    persistServers();
  };

  /**
   * 新增服务器并落盘，返回带生成 id 的完整配置
   * @param input - 用户填的表单（name/type/url/username/password）
   */
  const addServer = (input: StreamingServerInput): StreamingServerConfig => {
    const cfg: StreamingServerConfig = {
      id: crypto.randomUUID(),
      name: input.name.trim(),
      type: input.type,
      url: normalizeUrl(input.url),
      username: input.username,
      password: input.password,
    };
    servers.value = [...servers.value, cfg];
    persistServers();
    return cfg;
  };

  /**
   * 局部更新服务器配置；改 url/username/password/type 会清空 token + 视图鉴权缓存
   * @param id - 目标 server id
   * @param patch - 表单字段子集
   */
  const updateServer = (id: string, patch: Partial<StreamingServerInput>): void => {
    const idx = servers.value.findIndex((s) => s.id === id);
    if (idx < 0) return;
    const old = servers.value[idx];
    const credentialsChanged =
      (patch.url !== undefined && normalizeUrl(patch.url) !== old.url) ||
      (patch.username !== undefined && patch.username !== old.username) ||
      (patch.password !== undefined && patch.password !== old.password) ||
      (patch.type !== undefined && patch.type !== old.type);
    const next: StreamingServerConfig = {
      ...old,
      name: patch.name?.trim() ?? old.name,
      type: patch.type ?? old.type,
      url: patch.url !== undefined ? normalizeUrl(patch.url) : old.url,
      username: patch.username ?? old.username,
      password: patch.password ?? old.password,
      accessToken: credentialsChanged ? undefined : old.accessToken,
      userId: credentialsChanged ? undefined : old.userId,
    };
    if (credentialsChanged) client.invalidateViewAuth(id);
    const list = [...servers.value];
    list[idx] = next;
    servers.value = list;
    persistServers();
  };

  /**
   * 移除服务器；若目标是当前激活的，连同激活 ID + IndexedDB 浏览缓存一并清空
   * @param id - 目标 server id
   */
  const removeServer = (id: string): void => {
    client.invalidateViewAuth(id);
    servers.value = servers.value.filter((s) => s.id !== id);
    cacheDb.removeItem(cacheKey(id)).catch(() => {});
    if (activeServerId.value === id) {
      activeServerId.value = null;
      connectionStatus.value = { connected: false };
      clearMemoryLists();
    }
    persistServers();
  };

  /**
   * 用临时 cfg 测试连接
   * @param input - 用户填的表单
   */
  const testConnection = async (input: StreamingServerInput): Promise<StreamingPingResult> => {
    const tempCfg: StreamingServerConfig = {
      id: "__test__",
      name: input.name,
      type: input.type,
      url: normalizeUrl(input.url),
      username: input.username,
      password: input.password,
    };
    try {
      if (needsAccessToken(input.type)) {
        const auth = await client.authenticate(tempCfg);
        tempCfg.accessToken = auth.accessToken;
        tempCfg.userId = auth.userId;
      }
      return await client.ping(tempCfg);
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: classifyError(err),
      };
    }
  };

  /** runConnect 返回值；ok=false 时把具体错误透传给调用方 */
  type ConnectResult = { ok: true } | { ok: false; error: string; code: StreamingErrorCode };

  /**
   * 连接/重登的内部实现
   * @param id - 目标 server id
   * @param isActive - 写 connectionStatus 时再求值；避免长 await 期间用户切了 server，把旧结果写到当前激活态上
   */
  const runConnect = async (id: string, isActive: () => boolean): Promise<ConnectResult> => {
    const cfg = servers.value.find((s) => s.id === id);
    if (!cfg) return { ok: false, error: "找不到服务器配置", code: "unknown" };
    const writeStatus = (next: typeof connectionStatus.value): void => {
      if (isActive()) connectionStatus.value = next;
    };
    try {
      const updates: Partial<StreamingServerConfig> = {};
      let probe = cfg;
      if (needsAccessToken(cfg.type)) {
        const auth = await client.authenticate(cfg);
        updates.accessToken = auth.accessToken;
        updates.userId = auth.userId;
        probe = { ...cfg, ...updates };
      }
      const ping = await client.ping(probe);
      if (!ping.ok) {
        const code = ping.code ?? "unknown";
        const error = ping.error ?? "ping 失败";
        writeStatus({ connected: false, error, errorCode: code });
        return { ok: false, error, code };
      }
      updates.lastConnected = Date.now();
      patchServer(id, updates);
      writeStatus({ connected: true });
      if (id === activeServerId.value) refreshCoverUrlsForActive();
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const code = classifyError(err);
      writeStatus({ connected: false, error, errorCode: code });
      return { ok: false, error, code };
    }
  };

  /**
   * 连接到指定服务器；jellyfin/emby 自动登录拿 token，subsonic 系仅 ping
   * token 和 lastConnected 合并一次落盘
   * @param id - 目标 server id
   */
  const connectToServer = async (id: string): Promise<boolean> => {
    const r = await runConnect(id, () => id === activeServerId.value);
    return r.ok;
  };

  /**
   * 设为激活服务器并触发连接；id 与当前相同（断开状态重连）也会再走一遍
   * @param id - 目标 server id；传 null 则仅清空激活态
   */
  const setActiveServer = async (id: string | null): Promise<void> => {
    if (id !== activeServerId.value) {
      activeServerId.value = id;
      connectionStatus.value = { connected: false };
      hydrated.value = false;
      await hydrateFromCache();
      persistServers();
    }
    if (!id) return;
    await connectToServer(id);
  };

  /** 断开当前激活服务器（内存数据保留作为缓存显示，但 token 清空） */
  const disconnect = (): void => {
    const id = activeServerId.value;
    if (id) {
      patchServer(id, { accessToken: undefined, userId: undefined });
    }
    connectionStatus.value = { connected: false };
  };

  /**
   * 包装：执行 fn；遇到 StreamingAuthError 自动重登重试一次
   * 仅 jellyfin/emby 走重登；subsonic 系密码错就是错，没有 token 概念
   *
   * 重登只在重登目标 === 当前激活服务器时写全局 connectionStatus，
   * 否则（队列里混入其它 server 的 Track）只静默更新 token，不污染激活态
   */
  const withAutoReauthFor = async <T>(
    cfg: StreamingServerConfig,
    fn: (cfg: StreamingServerConfig) => Promise<T>,
  ): Promise<T> => {
    try {
      return await fn(cfg);
    } catch (err) {
      if (!(err instanceof StreamingAuthError) || !needsAccessToken(cfg.type)) throw err;
      const r = await runConnect(cfg.id, () => cfg.id === activeServerId.value);
      if (!r.ok) throw err;
      const refreshed = servers.value.find((s) => s.id === cfg.id);
      if (!refreshed) throw err;
      return fn(refreshed);
    }
  };

  /** 防止服务器切换或新一轮刷新被旧轮询覆盖 */
  let snapshotFetchSeq = 0;

  const applySnapshot = (snapshot: StreamingLibrarySnapshot): void => {
    const authoritative = snapshot.syncState.phase === "completed";
    if (authoritative || snapshot.songs.length > 0 || songs.value.length === 0) {
      songs.value = snapshot.songs;
    }
    if (authoritative || snapshot.albums.length > 0 || albums.value.length === 0) {
      albums.value = snapshot.albums;
    }
    if (authoritative || snapshot.artists.length > 0 || artists.value.length === 0) {
      artists.value = snapshot.artists;
    }
    if (authoritative || snapshot.playlists.length > 0 || playlists.value.length === 0) {
      playlists.value = snapshot.playlists;
    }
    lastFetchedAt.value = snapshot.syncState.completedAt ?? snapshot.syncState.startedAt ?? 0;
    refreshCoverUrlsForActive();
  };

  const waitForNextSnapshot = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 500));

  /** 从主进程 SQLite 读取快照，并在后台同步期间按批次刷新 */
  const fetchLibrarySnapshot = async (force = false): Promise<void> => {
    const serverId = activeServerId.value;
    if (!serverId) return;
    const seq = ++snapshotFetchSeq;
    loading.value = songs.value.length === 0;
    try {
      const initial = await window.api.streaming.getSnapshot(serverId);
      if (seq !== snapshotFetchSeq || activeServerId.value !== serverId) return;
      applySnapshot(initial);
      const initialGeneration = initial.syncState.generation;
      let lastCompleted = initial.syncState.completed;
      const started = await window.api.streaming.sync(serverId, force);
      if (!started) return;
      let polls = 0;
      while (seq === snapshotFetchSeq && activeServerId.value === serverId && polls < 240) {
        polls += 1;
        await waitForNextSnapshot();
        const syncState = await window.api.streaming.getSyncState(serverId);
        if (seq !== snapshotFetchSeq || activeServerId.value !== serverId) return;
        const completedChanged = syncState.completed !== lastCompleted;
        const completedNewGeneration = syncState.generation !== initialGeneration;
        const failed = syncState.phase === "failed";
        const terminal =
          syncState.phase === "completed" ||
          syncState.phase === "partial" ||
          syncState.phase === "failed";
        if (completedChanged || (completedNewGeneration && terminal)) {
          const snapshot = await window.api.streaming.getSnapshot(serverId);
          if (seq !== snapshotFetchSeq || activeServerId.value !== serverId) return;
          applySnapshot(snapshot);
          lastCompleted = syncState.completed;
        }
        if ((completedNewGeneration && terminal) || failed) break;
      }
    } catch (err) {
      console.error("[streaming] fetchLibrarySnapshot failed:", err);
    } finally {
      if (seq === snapshotFetchSeq) loading.value = false;
    }
  };

  const fetchSongs = fetchLibrarySnapshot;
  const fetchAlbums = (_params?: StreamingListParams, force = false): Promise<void> =>
    fetchLibrarySnapshot(force);
  const fetchArtists = fetchLibrarySnapshot;
  const fetchPlaylists = fetchLibrarySnapshot;

  /**
   * 拉取指定专辑的歌曲
   * @param albumId - 专辑 originalId
   * @returns 专辑歌曲
   */
  const fetchAlbumSongs = (albumId: string): Promise<Track[]> =>
    activeServerId.value
      ? window.api.streaming.getAlbumSongs(activeServerId.value, albumId)
      : Promise.reject(new Error("没有激活的流媒体服务器"));

  /**
   * 拉取指定歌单的歌曲
   * @param playlistId - 歌单 originalId
   * @returns 歌单歌曲
   */
  const fetchPlaylistSongs = (playlistId: string): Promise<Track[]> =>
    activeServerId.value
      ? window.api.streaming.getPlaylistSongs(activeServerId.value, playlistId)
      : Promise.reject(new Error("没有激活的流媒体服务器"));

  /**
   * 拉取指定歌手名下的专辑
   * @param artistId - 歌手 originalId
   * @returns 歌手专辑
   */
  const fetchArtistAlbums = (artistId: string): Promise<Album[]> =>
    activeServerId.value
      ? window.api.streaming.getArtistAlbums(activeServerId.value, artistId)
      : Promise.reject(new Error("没有激活的流媒体服务器"));

  /**
   * 拉取指定歌手名下的所有歌曲
   * @param artistId - 歌手 originalId
   * @returns 歌手歌曲
   */
  const fetchArtistSongs = (artistId: string): Promise<Track[]> =>
    activeServerId.value
      ? window.api.streaming.getArtistSongs(activeServerId.value, artistId)
      : Promise.reject(new Error("没有激活的流媒体服务器"));

  /**
   * 在激活服务器上搜索（歌曲/专辑/歌手聚合）
   * @param query - 搜索关键词
   */
  const search = (query: string): Promise<StreamingSearchResult> =>
    activeServerId.value
      ? window.api.streaming.search(activeServerId.value, query)
      : Promise.reject(new Error("没有激活的流媒体服务器"));

  /** Track.serverId 找 cfg；找不到抛错 */
  const findCfgForTrack = (track: Track): StreamingServerConfig => {
    if (track.source !== "streaming" || !track.serverId || !track.originalId) {
      throw new Error("非流媒体 Track");
    }
    const cfg = servers.value.find((s) => s.id === track.serverId);
    if (!cfg) throw new Error("找不到服务器配置");
    return cfg;
  };

  /**
   * 取流播放 URL
   * 非激活服务器静默重连
   * @param track - source="streaming" 的 Track（必须带 serverId/originalId）
   * @param opts.playSessionId - 覆盖默认 PlaySessionId；用于背景缓存下载与播放流并发时区分会话
   */
  const getStreamUrl = async (track: Track, opts?: { playSessionId?: string }): Promise<string> => {
    const cfg = findCfgForTrack(track);
    const isActive = cfg.id === activeServerId.value;
    const needsConnect = isActive
      ? !connectionStatus.value.connected
      : needsAccessToken(cfg.type) && !cfg.accessToken;
    if (needsConnect) {
      const result = await runConnect(cfg.id, () => cfg.id === activeServerId.value);
      if (!result.ok) throw new Error(isActive ? result.error : `${cfg.name}: ${result.error}`);
    }
    const fresh = servers.value.find((s) => s.id === cfg.id) ?? cfg;
    const sessionId = opts?.playSessionId ?? session.sessionIdForTrack(track.id);
    return withAutoReauthFor(fresh, (c) => client.getStreamUrl(c, track.originalId!, sessionId));
  };

  /**
   * 取流媒体歌词
   * @param track - source="streaming" 的 Track
   */
  const getLyrics = async (track: Track): Promise<string | null> => {
    try {
      const cfg = findCfgForTrack(track);
      return await withAutoReauthFor(cfg, (c) =>
        client.getLyrics(c, track.originalId!, {
          artist: track.artists?.[0]?.name,
          title: track.title,
        }),
      );
    } catch (err) {
      console.warn("[streaming] getLyrics failed:", err);
      return null;
    }
  };

  const init = async (): Promise<void> => {
    if (hydrated.value) return;
    const result = await window.api.streaming.loadServers();
    servers.value = result.servers;
    activeServerId.value = result.activeServerId;
    if (activeServerId.value && !servers.value.find((s) => s.id === activeServerId.value)) {
      activeServerId.value = null;
    }
    await hydrateFromCache();
    if (activeServerId.value) void connectToServer(activeServerId.value);
  };

  return {
    // state
    servers,
    activeServerId,
    activeServer,
    connectionStatus,
    loading,
    hasServer,
    isConnected,
    hydrated,
    lastFetchedAt,
    songs,
    albums,
    artists,
    playlists,
    // lifecycle
    init,
    // server management
    addServer,
    updateServer,
    removeServer,
    setActiveServer,
    connectToServer,
    disconnect,
    testConnection,
    // browse
    fetchAlbums,
    fetchArtists,
    fetchPlaylists,
    fetchSongs,
    fetchAlbumSongs,
    fetchPlaylistSongs,
    fetchArtistAlbums,
    fetchArtistSongs,
    search,
    // 供播放器与歌词加载服务调用
    getStreamUrl,
    getLyrics,
  };
});
