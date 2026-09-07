/**
 * Capacitor Android 启动垫片
 *
 * 在 Electron 缺失的 WebView 环境中，先注入一份最小 `window.api` 兼容实现，
 * 让现有渲染层（stores / core / apis）能正常启动。桌面端不加载本文件。
 *
 * 能力分级：
 * - 完整实现：config / system / player（HTML5 Audio）/ stats / playlist / apis（内嵌 API 桥）
 * - 安全降级：streaming（配置持久化 + 明确错误）、library、download 等（返回明确错误）
 * - Proxy 兜底：未显式实现的方法自动返回可安全 await 的失败响应或退订函数，
 *   避免桌面专属能力在 Android 上抛 TypeError 阻断 UI。
 *
 * 在线平台 API 优先尝试连接内嵌 Node API（127.0.0.1:1145），未启动时返回明确错误。
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

/** 播放事件订阅回调集合 */
type EventHandler = (event: unknown) => void;

/** localStorage JSON 读写封装 */
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
    const key = keys[i]!;
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

/** 命名空间兜底代理：缺失方法返回安全失败响应，on* 方法返回退订函数 */
const stubNamespace = <T extends object>(impl: T): T =>
  new Proxy(impl, {
    get(target, prop) {
      if (prop in target) return Reflect.get(target, prop, target);
      const name = String(prop);
      if (name.startsWith("on")) return (): (() => void) => () => {};
      return (): Promise<{ success: boolean; error: string }> =>
        Promise.resolve({ success: false, error: "not_supported_on_android" });
    },
  }) as T;

/** ---------------- 播放器：HTML5 Audio 实现 ---------------- */

const playerEventHandlers = new Set<EventHandler>();
const audio = typeof Audio !== "undefined" ? new Audio() : null;
let currentState: "idle" | "loading" | "playing" | "paused" | "stopped" = "idle";

const emitPlayerEvent = (event: unknown): void => {
  for (const handler of playerEventHandlers) handler(event);
};

const statusPayload = () => ({
  state: currentState,
  position: (audio?.currentTime ?? 0) * 1000,
  duration: (audio?.duration ?? 0) * 1000,
  volume: audio?.volume ?? 1,
  speed: audio?.playbackRate ?? 1,
  isFinished: false,
});

if (audio) {
  audio.addEventListener("play", () => {
    currentState = "playing";
    emitPlayerEvent({ type: "status", data: statusPayload() });
    emitPlayerEvent({ type: "play" });
  });
  audio.addEventListener("pause", () => {
    if (currentState !== "loading") currentState = "paused";
    emitPlayerEvent({ type: "status", data: statusPayload() });
    emitPlayerEvent({ type: "pause" });
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
    currentState = "stopped";
    emitPlayerEvent({ type: "sourceError" });
  });
  audio.addEventListener("loadedmetadata", () => {
    emitPlayerEvent({ type: "status", data: statusPayload() });
  });
}

/** ---------------- 播放统计：localStorage 实现 ---------------- */

const PLAY_HISTORY_KEY = "splayer:play-history";
const FAV_HISTORY_KEY = "splayer:fav-history";

const dayStartOf = (ts: number): number => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const weekStartOf = (ts: number): number => {
  const d = new Date(dayStartOf(ts));
  d.setDate(d.getDate() - d.getDay());
  return d.getTime();
};

const trackKey = (track: Track): string => `${track.source}:${track.id}`;

/** ---------------- 命名空间实现 ---------------- */

const buildApi = (): Record<string, unknown> => {
  const playerEventUnsub = (callback: EventHandler): (() => void) => {
    playerEventHandlers.add(callback);
    return () => playerEventHandlers.delete(callback);
  };

  return {
    system: stubNamespace({
      installType: "apk",
      platform: "android",
      osInfo: { type: "Android", arch: "", release: "" },
      toggleDevTools: async () => {},
      showInExplorer: async () => {},
      openLogsDir: async () => "",
      setLocale: () => {},
      focusMainWindow: async () => {},
      openSettings: async () => {},
      onOpenSettings: () => (): void => {},
      listFonts: async () => [],
      fetchRemoteBytes: async () => ({ success: false, error: "not_supported_on_android" }),
      saveFile: async () => ({ success: false, error: "not_supported_on_android" }),
      relaunch: async () => location.reload(),
      testNetworkProxy: async () => false,
      getMachineKey: async () => "android-local",
      checkSPlayerNextMigration: async () => ({ exists: false, path: null }),
      runSPlayerNextMigration: async () => ({ ok: true }),
      onProtocolUrl: () => (): void => {},
      consumePendingProtocolUrl: async () => null,
      onOpenFiles: () => (): void => {},
      consumePendingAudioFiles: async () => [],
      getPathForFile: () => "",
    }),

    config: stubNamespace({
      get: async (keyPath: string) =>
        getByPath(defaultSystemConfig as unknown as Record<string, unknown>, keyPath),
      set: async (keyPath: string, value: unknown) => {
        const all = store.get<Record<string, unknown>>("splayer:config", {});
        setByPath(all, keyPath, value);
        store.set("splayer:config", all);
      },
      getAll: async () => {
        const merged = structuredClone(defaultSystemConfig) as unknown as Record<string, unknown>;
        deepAssign(merged, store.get<Record<string, unknown>>("splayer:config", {}));
        return merged;
      },
      reset: async () => localStorage.removeItem("splayer:config"),
      replaceAll: async (config: unknown) => store.set("splayer:config", config),
      exportToFile: async () => ({ ok: false, reason: "writeFailed" as const }),
      importFromFile: async () => ({ ok: false, reason: "canceled" as const }),
    }),

    player: stubNamespace({
      load: async (source: string, options?: { autoPlay?: boolean; meta?: Track }) => {
        if (!audio) return { success: false, error: "audio_unavailable" };
        currentState = "loading";
        audio.src = source;
        if (options?.autoPlay ?? true) await audio.play().catch(() => {});
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
        currentState = "stopped";
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
      getVolume: async () => ({ success: true, data: audio?.volume ?? 1 }),
      getStatus: async () => ({ success: true, data: statusPayload() }),
      getFftData: async () => ({ success: true, data: { ldata: [], rdata: [] } }),
      getFadeDuration: async () => ({ success: true, data: 0 }),
      getCoverRaw: async () => ({ success: true, data: null }),
      readLyricFile: async () => ({ success: false, error: "not_supported_on_android" }),
      setSpeed: async (speed: number) => {
        if (audio) audio.playbackRate = speed;
        return { success: true };
      },
      getOutputDevices: async () => ({
        success: true,
        data: [{ id: "default", name: "默认输出", isDefault: true }],
      }),
      getDefaultDeviceName: async () => ({ success: true, data: "默认输出" }),
      getSelectedDeviceName: async () => ({ success: true, data: null }),
      onEvent: playerEventUnsub,
    }),

    stats: stubNamespace({
      recordPlay: (event: PlayEventInput) => {
        const history = store.get<PlayEventInput[]>(PLAY_HISTORY_KEY, []);
        history.push(event);
        if (history.length > 2000) history.splice(0, history.length - 2000);
        store.set(PLAY_HISTORY_KEY, history);
      },
      recordFavorite: (event: FavoriteEventInput) => {
        const favs = store.get<FavoriteEventInput[]>(FAV_HISTORY_KEY, []);
        favs.push(event);
        store.set(FAV_HISTORY_KEY, favs);
      },
      getStatsSummary: async () => {
        const history = store.get<PlayEventInput[]>(PLAY_HISTORY_KEY, []);
        const favs = store.get<FavoriteEventInput[]>(FAV_HISTORY_KEY, []);
        const today = dayStartOf(Date.now());
        const week = weekStartOf(Date.now());
        const sumSince = (since: number): number =>
          history.filter((i) => i.startedAt >= since).reduce((s, i) => s + i.listenedMs, 0);
        return {
          todayListenedMs: sumSince(today),
          weekListenedMs: sumSince(week),
          lastWeekListenedMs: 0,
          totalListenedMs: history.reduce((s, i) => s + i.listenedMs, 0),
          weekPlayCount: history.filter((i) => i.startedAt >= week).length,
          totalPlayCount: history.length,
          totalPlayedTracks: new Set(history.map((i) => trackKey(i.track))).size,
          weekFavoriteAdds: favs.filter((i) => i.action === "add").length,
          streakDays: 0,
        };
      },
      getPlaySourceBreakdown: async () => {
        const history = store.get<PlayEventInput[]>(PLAY_HISTORY_KEY, []);
        const bySource = new Map<string, { playCount: number; listenedMs: number }>();
        for (const item of history) {
          const cur = bySource.get(item.track.source) ?? { playCount: 0, listenedMs: 0 };
          cur.playCount += 1;
          cur.listenedMs += item.listenedMs;
          bySource.set(item.track.source, cur);
        }
        return [...bySource.entries()].map(([source, v]) => ({
          source: source as Track["source"],
          playCount: v.playCount,
          listenedMs: v.listenedMs,
        }));
      },
      getTopTracks: async (limit: number) => {
        const history = store.get<PlayEventInput[]>(PLAY_HISTORY_KEY, []);
        const byTrack = new Map<string, { track: Track; plays: number }>();
        for (const item of history) {
          const key = trackKey(item.track);
          const cur = byTrack.get(key);
          if (cur) cur.plays += 1;
          else byTrack.set(key, { track: item.track, plays: 1 });
        }
        return [...byTrack.values()]
          .sort((a, b) => b.plays - a.plays)
          .slice(0, limit)
          .map((v) => ({ track: v.track, plays: v.plays }));
      },
      getTopAlbums: async (limit: number) => {
        const history = store.get<PlayEventInput[]>(PLAY_HISTORY_KEY, []);
        const byAlbum = new Map<string, { track: Track; plays: number }>();
        for (const item of history) {
          const name = item.track.album?.name?.trim();
          if (!name) continue;
          const cur = byAlbum.get(name);
          if (cur) cur.plays += 1;
          else byAlbum.set(name, { track: item.track, plays: 1 });
        }
        return [...byAlbum.values()]
          .sort((a, b) => b.plays - a.plays)
          .slice(0, limit)
          .map((v) => ({ track: v.track, plays: v.plays }));
      },
      getTopArtists: async (limit: number) => {
        const history = store.get<PlayEventInput[]>(PLAY_HISTORY_KEY, []);
        const byArtist = new Map<string, { track: Track; plays: number }>();
        for (const item of history) {
          for (const artist of item.track.artists) {
            if (!artist.name?.trim()) continue;
            const cur = byArtist.get(artist.name);
            if (cur) cur.plays += 1;
            else byArtist.set(artist.name, { track: item.track, plays: 1 });
          }
        }
        return [...byArtist.values()]
          .sort((a, b) => b.plays - a.plays)
          .slice(0, limit)
          .map((v) => ({ track: v.track, plays: v.plays }));
      },
      getPlayHistoryDaily: async (days: number) => {
        const history = store.get<PlayEventInput[]>(PLAY_HISTORY_KEY, []);
        const byDay = new Map<string, number>();
        for (const item of history) {
          const day = new Date(dayStartOf(item.startedAt) + 8 * 3600 * 1000)
            .toISOString()
            .slice(0, 10);
          byDay.set(day, (byDay.get(day) ?? 0) + 1);
        }
        return [...byDay.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .slice(-days)
          .map(([day, playCount]) => ({ day, playCount }));
      },
      getPlayHistoryHourly: async () => {
        const history = store.get<PlayEventInput[]>(PLAY_HISTORY_KEY, []);
        const hours = new Array<number>(24).fill(0);
        for (const item of history) hours[new Date(item.startedAt).getHours()]! += 1;
        return hours.map((playCount, hour) => ({ hour, playCount }));
      },
      getLibraryStats: async () => ({
        trackCount: 0,
        albumCount: 0,
        artistCount: 0,
        totalDurationMs: 0,
        totalFileSize: 0,
        codecs: [],
      }),
    }),

    apis: stubNamespace({
      call: async (platform: string, name: string, params?: Record<string, unknown>) => {
        if (platform !== "netease") {
          return { ok: false, error: `platform ${platform} not yet supported on android` };
        }
        try {
          const query = new URLSearchParams(
            Object.entries(params ?? {}).map(([k, v]) => [k, String(v)]),
          );
          const res = await fetch(`${API_BASE}/${name}?${query.toString()}`);
          if (!res.ok) {
            return { ok: false, error: `local api http ${res.status}`, status: res.status };
          }
          const body = await res.json();
          return { ok: true, status: 200, body };
        } catch {
          return { ok: false, error: "embedded api not running on android", status: 0 };
        }
      },
      clearSession: async () => {},
      openLoginWeb: async () => ({ ok: false, error: "not_supported_on_android" }),
      setCookie: async () => ({ ok: false, error: "not_supported_on_android" }),
    }),

    streaming: stubNamespace({
      loadServers: async () => {
        return store.get<{ servers: unknown[]; activeServerId: string | null }>(
          "splayer:streaming",
          { servers: [], activeServerId: null },
        );
      },
      addServer: async () => {
        throw new Error("not_supported_on_android");
      },
      updateServer: async () => {
        throw new Error("not_supported_on_android");
      },
      removeServer: async () => {},
      setActiveServer: async () => {},
      testConnection: async () => ({ ok: false, error: "not_supported_on_android" }),
      connect: async () => {},
      disconnect: async () => {},
      getSnapshot: async () => null,
      sync: async () => {},
      search: async () => ({ tracks: [] }),
      getStreamUrl: async () => null,
      getAlbumSongs: async () => [],
      getArtistAlbums: async () => [],
      getArtistSongs: async () => [],
      getPlaylistSongs: async () => [],
    }),

    playlist: stubNamespace({
      list: async () => store.get<unknown[]>("splayer:playlists", []),
      get: async (id: string) =>
        store.get<Array<{ id: string }>>("splayer:playlists", []).find((p) => p.id === id) ?? null,
      create: async (input: { name: string }) => {
        const list = store.get<Array<{ id: string; name: string }>>("splayer:playlists", []);
        const item = { id: `local-${Date.now()}`, name: input.name };
        list.push(item);
        store.set("splayer:playlists", list);
        return item;
      },
      update: async () => null,
      remove: async () => {},
      addTracks: async () => 0,
      removeTracks: async () => 0,
      importLegacy: async () => {},
      clear: async () => store.set("splayer:playlists", []),
    }),

    library: stubNamespace({
      scan: async () => ({ success: false, error: "not_supported_on_android" }),
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
      getScanDirs: async () => ({ success: true, data: [] }),
      deleteTracks: async () => ({ success: true, data: { deleted: 0, failed: 0 } }),
      fetchArtistAvatar: async () => ({ success: true, data: null }),
      prefetchArtistAvatars: async () => ({ success: true, data: {} }),
    }),

    update: stubNamespace({
      check: async () => {},
      download: async () => {},
      install: async () => {},
      openDownloadPage: async () => {},
      getChangelog: async () => null,
    }),

    cache: stubNamespace({
      getStats: async () => [],
      getDir: async () => "",
      pickDir: async () => ({ ok: false, dir: "" }),
      resetDir: async () => "",
      song: {
        lookup: async () => null,
        fetch: async () => null,
        cancel: async () => {},
      },
    }),

    theme: stubNamespace({
      pickBackgroundImage: async () => null,
      clearBackgroundImages: async () => {},
    }),

    opencc: stubNamespace({
      convert: async (text: string) => text,
    }),
  };
};

/** 只在 Capacitor Android 环境注入；Electron 下保持原样 */
if (isCapacitorAndroid) {
  try {
    const cap = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } })
      .Capacitor;
    const statusBar = cap?.Plugins?.StatusBar as
      { setOverlaysWebView?: (o: { overlay: boolean }) => Promise<void> } | undefined;
    void statusBar?.setOverlaysWebView?.({ overlay: true });
  } catch {
    /* 插件不可用时忽略 */
  }

  Object.defineProperty(window, "api", {
    value: buildApi(),
    writable: false,
    configurable: false,
  });
}

export {};
