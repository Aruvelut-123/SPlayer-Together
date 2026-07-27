import type { Track, TrackDetail } from "@shared/types/player";
import type { LyricData, LyricFormat, LyricInput, LyricMatchResult } from "@shared/types/lyrics";
import type { Platform } from "@shared/types/platform";
import { isPlatform } from "@shared/types/platform";
import { detectFormat } from "@/utils/lyric/parse";
import { useSettingsStore } from "@/stores/settings";
import { useStreamingStore } from "@/stores/streaming";
import { usePluginsStore } from "@/stores/plugins";
import { DEFAULT_LYRIC_FORMAT_ORDER, DEFAULT_LYRIC_SOURCE_ORDER } from "@/types/settings";

/** 歌词下一首预载 */
const prefetchCache = new Map<string, Promise<unknown>>();

/**
 * 包装网络请求
 * 若命中预载缓存则直接返回并清理缓存，否则发起真实请求
 */
const withPrefetchCache = <T>(key: string, fetcher: () => Promise<T>): Promise<T> => {
  if (prefetchCache.has(key)) {
    const cachedPromise = prefetchCache.get(key)! as Promise<T>;
    prefetchCache.delete(key);
    return cachedPromise;
  }
  return fetcher();
};

/** 触发预载网络请求并存入缓存字典 */
const seedPrefetchCache = <T>(key: string, fetcher: () => Promise<T>): void => {
  if (!prefetchCache.has(key)) {
    prefetchCache.set(key, fetcher());
  }
};

/** 一次在线 fetch 的结果 */
export interface OnlineResult {
  source: { source: "online"; format: LyricFormat; platform: Platform };
  input: LyricInput;
}

/** 已解析的原始歌词候选 */
export interface ResolvedLyric {
  source: NonNullable<LyricData>;
  input: LyricInput;
}

/** 本地歌词读取结果 */
export type LocalLyric = { source: NonNullable<LyricData>; content: string };

/** 匹配结果转为可提交歌词输入 */
export const toLyricInput = (data: LyricMatchResult): LyricInput => ({
  content: data.content,
  translation: data.translation,
  translationFormat: data.translationFormat,
  romaji: data.romaji,
  romajiFormat: data.romajiFormat,
});

/** 匹配结果转为在线歌词结果 */
export const toOnlineResult = (data: LyricMatchResult): OnlineResult => ({
  source: { source: "online", format: data.format, platform: data.platform },
  input: toLyricInput(data),
});

/** 提取内嵌歌词兜底 */
export const embeddedLyricFromDetail = (detail: TrackDetail | null): LocalLyric | null => {
  if (!detail?.embeddedLyric) return null;
  return {
    source: { source: "embedded", format: detectFormat(detail.embeddedLyric) },
    content: detail.embeddedLyric,
  };
};

/**
 * 向指定平台请求歌词
 * track.platform 等于目标平台时走 byId（精确），否则 byQuery（搜索打分）
 */
export const fetchFromPlatform = (
  platform: Platform,
  track: Track,
): Promise<OnlineResult | null> => {
  return withPrefetchCache(`platform:${platform}:${track.id}`, async () => {
    const mode = track.source === platform ? "byId" : "byQuery";
    // QM lyric 接口要数字 songID
    const lookupId = platform === "qqmusic" ? (track.extId ?? track.id) : track.id;
    const resp =
      mode === "byId"
        ? await window.api.lyrics.matchById(platform, lookupId)
        : await window.api.lyrics.matchByQuery(platform, track);
    if (!resp.ok || !resp.data) return null;
    return toOnlineResult(resp.data);
  });
};

/** 平台主格式可达列表 */
const PLATFORM_MAIN_FORMATS: Record<Platform, LyricFormat[]> = {
  netease: ["yrc", "lrc"],
  qqmusic: ["qrc", "lrc"],
  kugou: ["krc", "lrc"],
};

/**
 * 判断在指定平台是否能拿到比本地更优的主格式
 * @param platform - 平台
 * @param localFormat - 本地格式
 * @param formatOrder - 格式优先级
 */
const platformCanUpgrade = (
  platform: Platform,
  localFormat: LyricFormat,
  formatOrder: readonly LyricFormat[],
): boolean => {
  const localIdx = formatOrder.indexOf(localFormat);
  if (localIdx === -1) return true;
  for (const f of PLATFORM_MAIN_FORMATS[platform] ?? []) {
    const idx = formatOrder.indexOf(f);
    if (idx !== -1 && idx < localIdx) return true;
  }
  return false;
};

/**
 * 单次在线结果是否真的优于本地
 * @param result - 在线结果
 * @param localFormat - 本地格式
 */
const isOnlineResultUpgrade = (result: OnlineResult, localFormat: LyricFormat): boolean => {
  const settings = useSettingsStore();
  const formatOrder = settings.lyric.lyricFormatOrder ?? DEFAULT_LYRIC_FORMAT_ORDER;
  const localIdx = formatOrder.indexOf(localFormat);
  if (localIdx === -1) return true;
  const mainIdx = formatOrder.indexOf(result.source.format);
  return mainIdx !== -1 && mainIdx < localIdx;
};

interface OnlinePreferenceOptions {
  hasLocal: boolean;
  localFormat: LyricFormat | null;
  onCandidate?: (result: OnlineResult) => void;
  shouldContinue?: () => boolean;
}

/**
 * 按当前歌词来源偏好获取在线歌词
 * @param track - 歌曲信息
 * @param options - 本地歌词与竞态选项
 */
export const resolveOnlineByPreference = async (
  track: Track,
  options: OnlinePreferenceOptions,
): Promise<OnlineResult | null> => {
  const settings = useSettingsStore();
  const preference = settings.lyric.lyricSourcePreference;
  const isCurrent = options.shouldContinue ?? (() => true);
  if (preference === "self") {
    if (isPlatform(track.source)) return fetchFromPlatform(track.source, track);
    return null;
  }
  if (preference === "auto") {
    const order = settings.lyric.lyricSourceOrder ?? DEFAULT_LYRIC_SOURCE_ORDER;
    const formatOrder = settings.lyric.lyricFormatOrder ?? DEFAULT_LYRIC_FORMAT_ORDER;
    let candidates: Platform[] = [...order];
    if (options.hasLocal) {
      if (!settings.lyric.smartPreferOnline || !options.localFormat) return null;
      candidates = order.filter((p) => platformCanUpgrade(p, options.localFormat!, formatOrder));
      if (candidates.length === 0) return null;
    }
    if (settings.lyric.smartPreferOnline) {
      let best: OnlineResult | null = null;
      const localIdx =
        options.hasLocal && options.localFormat ? formatOrder.indexOf(options.localFormat) : -1;
      let bestRank = localIdx === -1 ? Infinity : localIdx;
      await Promise.all(
        candidates.map(async (platform) => {
          const result = await fetchFromPlatform(platform, track);
          if (!isCurrent() || !result) return;
          const idx = formatOrder.indexOf(result.source.format);
          const rank = idx === -1 ? Infinity : idx;
          if (rank < bestRank) {
            best = result;
            bestRank = rank;
            options.onCandidate?.(result);
          }
        }),
      );
      if (!isCurrent()) return null;
      return best;
    }
    for (const platform of candidates) {
      const result = await fetchFromPlatform(platform, track);
      if (!isCurrent()) return null;
      if (!result) continue;
      if (
        options.hasLocal &&
        options.localFormat &&
        !isOnlineResultUpgrade(result, options.localFormat)
      ) {
        continue;
      }
      return result;
    }
    return null;
  }
  return fetchFromPlatform(preference, track);
};

/**
 * 判断是否应该尝试 TTML 升级（与平台无关，仅看格式优先级）
 * @param mainFormat - 当前主歌词格式
 */
const shouldTryTTMLByFormat = (mainFormat: LyricFormat): boolean => {
  const settings = useSettingsStore();
  if (!settings.system.lyric.enableOnlineTTMLLyric) return false;
  if (settings.lyric.lyricSourcePreference === "self") return false;
  const order = settings.lyric.lyricFormatOrder ?? DEFAULT_LYRIC_FORMAT_ORDER;
  const ttmlIdx = order.indexOf("ttml");
  if (ttmlIdx === -1) return false;
  const mainIdx = order.indexOf(mainFormat);
  if (mainIdx === -1) return true;
  return ttmlIdx < mainIdx;
};

/** 支持 AMLL TTML DB 的平台列表 */
const TTML_PLATFORMS: readonly ("netease" | "qqmusic")[] = ["netease", "qqmusic"];

/**
 * 拉取在线歌词对应的 TTML 覆盖版本
 * @param track - 歌曲信息
 * @param online - 在线歌词结果
 */
export const resolveTTMLOverlay = async (
  track: Track,
  online: OnlineResult,
): Promise<ResolvedLyric | null> => {
  if (!shouldTryTTMLByFormat(online.source.format)) return null;
  const candidates = await Promise.all(
    TTML_PLATFORMS.map(async (platform) => ({
      platform,
      response: await withPrefetchCache(`ttml:${platform}:${track.id}`, () =>
        window.api.lyrics.fetchTTMLOverlay(track, platform),
      ),
    })),
  );
  const match = candidates.find(
    (candidate): candidate is typeof candidate & { response: { ok: true; data: string } } =>
      candidate.response.ok && !!candidate.response.data,
  );
  if (!match) return null;
  return {
    source: { source: "online", format: "ttml", platform: match.platform },
    input: { content: match.response.data },
  };
};

/**
 * 本地 TTML 歌词库匹配
 * @param track - 歌曲信息
 */
export const resolveLocalRepoLyric = async (track: Track): Promise<ResolvedLyric | null> => {
  const settings = useSettingsStore();
  if (
    !settings.system.localLyric?.enableLocalTTMLOverride ||
    !settings.system.localLyric?.repoDir
  ) {
    return null;
  }
  const resp = await window.api.lyrics.matchLocalTTML(track);
  if (!resp.ok || !resp.data) return null;
  return { source: { source: "external", format: "ttml" }, input: { content: resp.data } };
};

/**
 * 插件兜底匹配歌词
 * @param track - 歌曲信息
 */
export const resolvePluginLyric = async (track: Track): Promise<ResolvedLyric | null> => {
  const plugins = usePluginsStore();
  for (const info of plugins.list) {
    if (!info.enabled || info.status.state !== "ready") continue;
    for (const [source, cap] of Object.entries(info.status.sources)) {
      if (!cap.actions.includes("musicLyric")) continue;
      const resp = await window.api.plugins.matchLyric({
        pluginId: info.manifest.id,
        source,
        track,
      });
      if (!resp.ok || !resp.data) continue;
      const content = resp.data.awlyric ?? resp.data.lyric;
      if (!content || !content.trim()) continue;
      return {
        source: { source: "online", format: detectFormat(content) },
        input: { content, translation: resp.data.tlyric, romaji: resp.data.rlyric },
      };
    }
  }
  return null;
};

/**
 * 取流媒体服务端歌词
 * @param track - 歌曲信息
 */
export const resolveStreamingServerLyric = (track: Track): Promise<ResolvedLyric | null> => {
  return withPrefetchCache(`streaming:${track.id}`, async () => {
    const text = await useStreamingStore().getLyrics(track);
    if (!text?.trim()) return null;
    return { source: { source: "external", format: detectFormat(text) }, input: { content: text } };
  });
};

/**
 * 触发候选歌曲的网络歌词预拉取
 * @param track - 候选歌曲
 */
export const prefetchLyricForTrack = (track: Track): void => {
  const settings = useSettingsStore();
  if (track.source === "streaming") {
    seedPrefetchCache(`streaming:${track.id}`, () => resolveStreamingServerLyric(track));
  }
  const preference = settings.lyric.lyricSourcePreference;
  if (preference === "self") {
    const source = track.source;
    if (isPlatform(source)) {
      seedPrefetchCache(`platform:${source}:${track.id}`, () => fetchFromPlatform(source, track));
    }
  } else if (preference === "auto") {
    const order = settings.lyric.lyricSourceOrder ?? DEFAULT_LYRIC_SOURCE_ORDER;
    order.forEach((p) => {
      seedPrefetchCache(`platform:${p}:${track.id}`, () => fetchFromPlatform(p, track));
    });
  }

  // 预载 TTML 覆盖（仅在非 self 模式且开启 TTML 时有效）
  if (settings.system.lyric.enableOnlineTTMLLyric && preference !== "self") {
    TTML_PLATFORMS.forEach((p) => {
      seedPrefetchCache(`ttml:${p}:${track.id}`, () =>
        window.api.lyrics.fetchTTMLOverlay(track, p),
      );
    });
  }
};
