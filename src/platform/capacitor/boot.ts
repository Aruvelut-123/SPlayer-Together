/**
 * Capacitor Android 启动垫片
 *
 * 在 Electron 缺失的 WebView 环境中，先注入一份最小 `window.api` 兼容实现，
 * 让现有渲染层（stores / core / apis）能正常启动。桌面端不加载本文件。
 *
 * 播放使用 HTML5 Audio 元素；统计与配置使用 localStorage；在线平台 API 优先
 * 尝试连接内嵌的本地 Node API（127.0.0.1:1145，见 API/mobile-server.ts），
 * 未启动时返回明确的不可用错误。流媒体库、下载、本地文件库等桌面专属能力
 * 提供安全降级（空数据 / 明确错误），不阻断 UI 启动。
 */

import type { Track } from "@shared/types/player";
import type { PlayEventInput, FavoriteEventInput } from "@shared/types/stats";
import { defaultSystemConfig } from "@shared/defaults/settings";

const isCapacitorAndroid =
  typeof window !== "undefined" &&
  typeof (window as unknown as { Capacitor?: unknown }).Capacitor !== "undefined" &&
  /Android/i.test(window.navigator.userAgent);

/** 在线 API 本地代理地址（与 API/mobile-server.ts 默认端口一致） */
const API_BASE = "http://127.0.0.1:1145";

/** 简单存储封装：localStorage 读写 JSON */
const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* 存储满或不可用时忽略 */
    }
  },
};

/** 播放事件订阅回调集合 */
type EventHandler = (event: unknown) => void;
const playerEventHandlers = new Set<EventHandler>();

const audio = typeof Audio !== "undefined" ? new Audio() : null;

/** 广播播放事件给渲染层订阅者 */
const emitPlayerEvent = (event: unknown): void => {
  for (const handler of playerEventHandlers) handler(event);
};

/** 播放器状态缓存（供 preview / status 轮询） */
let currentState: "idle" | "loading" | "playing" | "paused" | "stopped" = "idle";

if (audio) {
  audio.addEventListener("play", () => {
    currentState = "playing";
    emitPlayerEvent({
      type: "status",
      data: {
        state: "playing",
        position: audio.currentTime * 1000,
        duration: audio.duration * 1000 || 0,
        volume: audio.volume,
        speed: audio.playbackRate,
        isFinished: false,
      },
    });
  });
  audio.addEventListener("pause", () => {
    currentState = "paused";
    emitPlayerEvent({
      type: "status",
      data: {
        state: "paused",
        position: audio.currentTime * 1000,
        duration: audio.duration * 1000 || 0,
        volume: audio.volume,
        speed: audio.playbackRate,
        isFinished: false,
      },
    });
  });
  audio.addEventListener("timeupdate", () => {
    emitPlayerEvent({
      type: "position",
      data: { position: audio.currentTime * 1000, duration: audio.duration * 1000 || 0 },
    });
  });
  audio.addEventListener("ended", () => {
    emitPlayerEvent({ type: "ended" });
  });
  audio.addEventListener("error", () => {
    emitPlayerEvent({ type: "sourceError" });
  });
  audio.addEventListener("loadedmetadata", () => {
    emitPlayerEvent({
      type: "status",
      data: {
        state: "paused",
        position: 0,
        duration: audio.duration * 1000 || 0,
        volume: audio.volume,
        speed: audio.playbackRate,
        isFinished: false,
      },
    });
  });
}

/** 通过 Capacitor StatusBar 插件设置状态栏样式（存在时） */
const setStatusBarStyle = (): void => {
  try {
    const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } })
      .Capacitor;
    const statusBar = cap?.Plugins?.StatusBar as
      { setOverlaysWebView?: (o: { overlay: boolean }) => Promise<void> } | undefined;
    void statusBar?.setOverlaysWebView?.({ overlay: true });
  } catch {
    /* 插件不可用时忽略 */
  }
};

/** 只在 Capacitor Android 环境注入；Electron 下保持原样 */
if (isCapacitorAndroid) {
  setStatusBarStyle();

  const api = {
    system: {
      installType: "android",
      platform: "android",
      osInfo: { type: "Android", arch: "", release: "" },
      toggleDevTools: async () => {},
      showInExplorer: async () => {},
      openLogsDir: async () => "",
      setLocale: () => {},
      focusMainWindow: async () => {},
      openSettings: async () => {},
      onOpenSettings: () => () => {},
      listFonts: async () => [],
      fetchRemoteBytes: async () => ({ success: false, error: "not supported on android" }),
      saveFile: async () => ({ success: false, error: "not supported on android" }),
      relaunch: async () => {},
      testNetworkProxy: async () => false,
      getMachineKey: async () => "android-local",
      checkSPlayerNextMigration: async () => ({ exists: false, path: null }),
      runSPlayerNextMigration: async () => ({ ok: true }),
      onProtocolUrl: () => () => {},
      consumePendingProtocolUrl: async () => null,
      onOpenFiles: () => () => {},
      consumePendingAudioFiles: async () => [],
      getPathForFile: () => "",
      openExternal: (url: string) => {
        window.open(url, "_blank", "noopener,noreferrer");
      },
    },
    config: {
      get: async (keyPath: string) =>
        getByPath(defaultSystemConfig as unknown as Record<string, unknown>, keyPath),
      set: async (keyPath: string, value: unknown) => {
        const all = store.get<Record<string, unknown>>("splayer:config", {});
        setByPath(all, keyPath, value);
        store.set("splayer:config", all);
      },
      getAll: async () => {
        const merged = structuredClone(defaultSystemConfig as unknown as Record<string, unknown>);
        deepAssign(merged, store.get<Record<string, unknown>>("splayer:config", {}));
        return merged;
      },
      reset: async () => {
        localStorage.removeItem("splayer:config");
      },
      replaceAll: async (config: unknown) => {
        store.set("splayer:config", config);
      },
      exportToFile: async () => ({ ok: false, reason: "writeFailed" as const }),
      importFromFile: async () => ({ ok: false, reason: "canceled" as const }),
    },
    player: {
      load: async (source: string, options?: { autoPlay?: boolean; meta?: Track }) => {
        if (!audio) return { success: false, error: "audio unavailable" };
        currentState = "loading";
        audio.src = source;
        if (options?.autoPlay ?? true) {
          await audio.play().catch(() => {});
        }
        return {
          success: true,
          data: {
            detail: {
              quality: { sampleRate: 0, channels: 2, bitsPerSample: 0, bitRate: 0, codec: "?" },
              externalLyrics: [],
            },
            mediaInfo: {
              duration: options?.meta?.duration ?? (audio.duration * 1000 || 0),
              title: options?.meta?.title,
              artists: options?.meta?.artists,
              album: options?.meta?.album,
              cover: options?.meta?.cover,
            },
          },
        };
      },
      play: async () => {
        await audio?.play().catch(() => {});
        return { success: true };
      },
      pause: async () => {
        audio?.pause();
        return { success: true };
      },
      stop: async () => {
        if (audio) {
          audio.pause();
          audio.removeAttribute("src");
          audio.load();
        }
        return { success: true };
      },
      seek: async (positionMs: number) => {
        if (audio) audio.currentTime = positionMs / 1000;
        return { success: true };
      },
      setVolume: async (volume: number) => {
        if (audio) audio.volume = volume;
        return { success: true };
      },
      setPauseOnDeviceSwitch: async () => ({ success: true }),
      getVolume: async () => ({ success: true, data: audio?.volume ?? 1 }),
      getStatus: async () => ({
        success: true,
        data: {
          state: currentState,
          position: (audio?.currentTime ?? 0) * 1000,
          duration: (audio?.duration ?? 0) * 1000,
          volume: audio?.volume ?? 1,
          speed: audio?.playbackRate ?? 1,
          isFinished: false,
        },
      }),
      setFftEnabled: async () => ({ success: true }),
      getFftData: async () => ({ success: true, data: { ldata: [], rdata: [] } }),
      setFadeDuration: async () => ({ success: true }),
      getFadeDuration: async () => ({ success: true, data: 0 }),
      getCoverRaw: async () => ({ success: true, data: null }),
      readLyricFile: async () => ({ success: true, data: "" }),
      reinit: async () => ({ success: true }),
      setNormalizationEnabled: async () => ({ success: true }),
      setEqualizerEnabled: async () => ({ success: true }),
      setEqualizerBands: async () => ({ success: true }),
      setPreampGain: async () => ({ success: true }),
      setSpeed: async (speed: number) => {
        if (audio) audio.playbackRate = speed;
        return { success: true };
      },
      setPitch: async () => ({ success: true }),
      setPitchSync: async () => ({ success: true }),
      getOutputDevices: async () => ({ success: true, data: [] }),
      getDefaultDeviceName: async () => ({ success: true, data: null }),
      setOutputDevice: async () => ({ success: true }),
      getSelectedDeviceName: async () => ({ success: true, data: null }),
      syncPlayMode: () => {},
      syncLikeState: () => {},
      dispatch: () => {},
      onEvent: (callback: EventHandler) => {
        playerEventHandlers.add(callback);
        return () => playerEventHandlers.delete(callback);
      },
    },
    stats: {
      recordPlay: (event: PlayEventInput) => {
        const history = store.get<PlayEventInput[]>("splayer:play-history", []);
        history.push(event);
        store.set("splayer:play-history", history);
      },
      recordFavorite: (event: FavoriteEventInput) => {
        const favs = store.get<FavoriteEventInput[]>("splayer:fav-history", []);
        favs.push(event);
        store.set("splayer:fav-history", favs);
      },
      getStatsSummary: async () => {
        const history = store.get<PlayEventInput[]>("splayer:play-history", []);
        const totalPlayCount = history.length;
        const totalListenedMs = history.reduce((sum, item) => sum + item.listenedMs, 0);
        const playedKeys = new Set(history.map((item) => `${item.track.source}:${item.track.id}`));
        const dayStart = new Date();
        dayStart.setHours(0, 0, 0, 0);
        const weekStart = new Date(dayStart);
        weekStart.setDate(weekStart.getDate() - dayStart.getDay());
        const todayListenedMs = history
          .filter((i) => i.startedAt >= dayStart.getTime())
          .reduce((s, i) => s + i.listenedMs, 0);
        const weekListenedMs = history
          .filter((i) => i.startedAt >= weekStart.getTime())
          .reduce((s, i) => s + i.listenedMs, 0);
        return {
          todayListenedMs,
          weekListenedMs,
          lastWeekListenedMs: 0,
          totalListenedMs,
          weekPlayCount: history.filter((i) => i.startedAt >= weekStart.getTime()).length,
          totalPlayCount,
          totalPlayedTracks: playedKeys.size,
          weekFavoriteAdds: store
            .get<FavoriteEventInput[]>("splayer:fav-history", [])
            .filter((i) => i.action === "add").length,
          streakDays: 0,
          _source: "android",
        } as never;
      },
      getPlaySourceBreakdown: async () => {
        const history = store.get<PlayEventInput[]>("splayer:play-history", []);
        const bySource = new Map<string, { playCount: number; listenedMs: number }>();
        for (const item of history) {
          const cur = bySource.get(item.track.source) ?? { playCount: 0, listenedMs: 0 };
          cur.playCount += 1;
          cur.listenedMs += item.listenedMs;
          bySource.set(item.track.source, cur);
        }
        return [...bySource.entries()].map(([source, v]) => ({
          source: source as never,
          playCount: v.playCount,
          listenedMs: v.listenedMs,
        }));
      },
      getTopTracks: async () => [],
      getLibraryStats: async () => ({
        trackCount: 0,
        albumCount: 0,
        artistCount: 0,
        totalDurationMs: 0,
        totalFileSize: 0,
        codecs: [],
      }),
      getPlayHistoryDaily: async () => [],
      getPlayHistoryHourly: async () => [],
      getTopAlbums: async () => [],
      getTopArtists: async () => [],
    },
    apis: {
      call: async (platform: string, name: string, params?: Record<string, unknown>) => {
        try {
          const res = await fetch(`${API_BASE}/${platform}/${name}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(params ?? {}),
          });
          if (!res.ok)
            return { ok: false, error: `local api http ${res.status}`, status: res.status };
          const body = await res.json();
          return { ok: true, status: 200, body };
        } catch {
          return { ok: false, error: "embedded api not running on android", status: 0 };
        }
      },
      clearSession: async () => {},
      openLoginWeb: async () => ({ ok: false, error: "not supported on android" }),
      setCookie: async () => ({ ok: false, error: "not supported on android" }),
    },
    streaming: {
      loadServers: async () => ({ servers: [], activeServerId: null }),
      addServer: async () => {
        throw new Error("not supported on android");
      },
      updateServer: async () => {
        throw new Error("not supported on android");
      },
      removeServer: async () => {},
      setActiveServer: async () => {},
      testConnection: async () => ({ ok: false }),
      connect: async () => {},
      disconnect: async () => {},
      getBrowsable: async () => ({ items: [] }),
      search: async () => ({ tracks: [] }),
      getCoverUrl: (id: string) => id,
    },
    library: {
      scan: async () => ({ success: false, error: "not supported on android" }),
      cancelScan: async () => ({ success: true }),
      getTracks: async () => ({ success: true, data: [] }),
      getAlbums: async () => ({ success: true, data: [] }),
      getArtists: async () => ({ success: true, data: [] }),
      getAlbumTracks: async () => ({ success: true, data: [] }),
      getArtistTracks: async () => ({ success: true, data: [] }),
      getTracksByIds: async () => ({ success: true, data: [] }),
      searchTracks: async () => ({ success: true, data: [] }),
      getTrackCount: async () => ({ success: true, data: 0 }),
      getRandomTrack: async () => ({ success: true, data: null }),
      getRandomTracks: async () => ({ success: true, data: [] }),
      isScanning: async () => ({ success: true, data: false }),
      addScanDir: async () => ({ success: false, error: "not supported on android" }),
      removeScanDir: async () => ({ success: true }),
      getScanDirs: async () => ({ success: true, data: [] }),
      deleteTracks: async () => ({ success: true, data: { deleted: 0, failed: 0 } }),
      readTags: async () => ({ success: false, error: "not supported on android" }),
      writeTags: async () => ({ success: true, data: [] }),
      pickCoverImage: async () => ({ success: false, error: "not supported on android" }),
      fetchArtistAvatar: async () => ({ success: true, data: null }),
      prefetchArtistAvatars: async () => ({ success: true, data: {} }),
      onScanProgress: () => () => {},
    },
    playlist: {
      list: async () => [],
      get: async () => null,
      create: async (input: { name: string }) => ({
        id: `local-${Date.now()}`,
        name: input.name,
        trackCount: 0,
      }),
      update: async () => null,
      remove: async () => {},
      addTracks: async () => 0,
      removeTracks: async () => 0,
      importLegacy: async () => {},
      clear: async () => {},
    },
    download: {
      start: async () => ({ ok: false, error: "not supported on android" }),
      startMany: async () => [],
      cancel: async () => {},
      retry: async () => ({ ok: false, error: "not supported on android" }),
      remove: async () => {},
      clearFinished: async () => {},
      list: async () => [],
      pickDir: async () => ({ ok: false, dir: "" }),
      getDir: async () => "",
      resetDir: async () => "",
      submitResolution: async () => {},
      failResolution: async () => {},
      onProgress: () => () => {},
      onState: () => () => {},
      onResolve: () => () => {},
    },
    update: {
      check: async () => {},
      download: async () => {},
      install: async () => {},
      openDownloadPage: async () => {},
      getChangelog: async () => null,
      onEvent: () => () => {},
    },
    hotkey: {
      register: async () => ({ success: true }),
      unregister: async () => ({ success: true }),
      getBindings: async () => ({ success: true, data: {} }),
      setBindings: async () => ({ success: true, data: {} }),
      onPressed: () => () => {},
    },
    window: {
      isDesktopLyricOpen: async () => false,
      isDynamicIslandOpen: async () => false,
      isTaskbarLyricOpen: async () => false,
      onDesktopLyricVisibilityChange: () => () => {},
      onDynamicIslandVisibilityChange: () => () => {},
      onTaskbarLyricVisibilityChange: () => () => {},
      openDesktopLyric: async () => {},
      closeDesktopLyric: async () => {},
      openDynamicIsland: async () => {},
      closeDynamicIsland: async () => {},
      openTaskbarLyric: async () => {},
      closeTaskbarLyric: async () => {},
    },
    desktopLyric: {
      onConfigChange: () => () => {},
      getConfig: async () => ({}),
      setConfig: async () => {},
    },
    dynamicIsland: {
      onConfigChange: () => () => {},
      getConfig: async () => ({}),
      setConfig: async () => {},
    },
    taskbarLyric: {
      onConfigChange: () => () => {},
      getConfig: async () => ({}),
      setConfig: async () => {},
    },
    nowPlaying: { get: async () => null },
    plugins: {
      list: async () => [],
      get: async () => null,
      install: async () => {},
      uninstall: async () => {},
      enable: async () => {},
      disable: async () => {},
      resolveUrl: async () => ({ ok: false, error: "not supported on android" }),
      onStatus: () => () => {},
      onLog: () => () => {},
      getMarkets: async () => [],
      refreshMarkets: async () => {},
      submitPlugin: async () => ({ ok: false }),
    },
    cloud: {
      upload: async () => ({ ok: false, error: "not supported on android" }),
      list: async () => [],
      remove: async () => {},
      onProgress: () => () => {},
    },
    comments: {
      get: async () => ({ comments: [] }),
      send: async () => ({ ok: false }),
      like: async () => {},
      dislike: async () => {},
    },
    lyrics: {
      get: async () => null,
      save: async () => {},
      delete: async () => {},
      getLocal: async () => null,
    },
    opencc: { convert: async (text: string) => text },
    theme: {
      pickBackgroundImage: async () => null,
      clearBackgroundImages: async () => {},
    },
    cache: {
      getStats: async () => [],
      clear: async () => {},
      clearAllByKind: async () => {},
      getDir: async () => "",
      pickDir: async () => ({ ok: false, dir: "" }),
      resetDir: async () => "",
      song: {
        lookup: async () => null,
        fetch: async () => null,
        cancel: async () => {},
      },
    },
    recognition: {
      start: async () => {},
      stop: async () => {},
      onMatch: () => () => {},
      onState: () => () => {},
    },
    lastfm: {
      auth: async () => ({ ok: false }),
      scrobble: async () => {},
      nowPlaying: async () => {},
      getStatus: async () => ({ connected: false }),
    },
    mcp: {
      restart: async () => ({}),
      getStatus: async () => ({}),
      getClientConfigParams: async () => ({}),
      detectAgents: async () => [],
      injectAgentConfig: async () => false,
      onStatus: () => () => {},
    },
    externalApi: {
      restart: async () => ({}),
      getStatus: async () => ({}),
      onStatus: () => () => {},
    },
    aiModel: {
      list: async () => [],
      get: async () => null,
      save: async () => {},
      remove: async () => {},
      chat: async () => ({ ok: false }),
      onStatus: () => () => {},
    },
  } as never;

  Object.defineProperty(window, "api", {
    value: api,
    writable: false,
    configurable: false,
  });
}

/** 按点号路径深取值 */
function getByPath<T = unknown>(obj: Record<string, unknown>, path: string): T | undefined {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[key];
    else return undefined;
  }
  return cur as T | undefined;
}

/** 按点号路径深设值 */
function setByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!cur[key] || typeof cur[key] !== "object") cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]!] = value;
}

/** 深合并：源对象覆盖目标对象叶子值 */
function deepAssign(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    const next = source[key];
    const cur = target[key];
    if (
      next &&
      typeof next === "object" &&
      !Array.isArray(next) &&
      cur &&
      typeof cur === "object" &&
      !Array.isArray(cur)
    ) {
      deepAssign(cur as Record<string, unknown>, next as Record<string, unknown>);
    } else if (cur !== next) {
      target[key] = next;
    }
  }
}

export {};
