/**
 * 下一首歌曲预载服务
 */

import type { Track } from "@shared/types/player";
import type { ResolvedTrackSource } from "@/services/audioSource";
import { resolveTrackSource } from "@/services/audioSource";
import { getNextTrackCandidate } from "@/core/player/candidate";
import { useStatusStore } from "@/stores/status";
import { useSettingsStore } from "@/stores/settings";
import { useStreamingStore } from "@/stores/streaming";
import { usePluginsStore } from "@/stores/plugins";
import * as queue from "@/stores/queue";

/** 预载结果 */
export interface NextTrackPreloadResult {
  trackId: string;
  source: ResolvedTrackSource | null;
  contextKey: string;
}

let currentToken = 0;
let cachedResult: NextTrackPreloadResult | null = null;
let currentContextKey: string | null = null;

/**
 * 拼装上下文指纹，用于去重与作废
 */
const buildContextKey = (track: Track): string => {
  const settings = useSettingsStore();
  const streaming = useStreamingStore();
  const plugins = usePluginsStore();

  const parts = [
    track.id,
    track.source,
    settings.player.songLevel,
    settings.player.allowTrialPlay,
    settings.preset.fuckDjMode,
    streaming.activeServerId ?? "",
    plugins.list.map((p) => `${p.manifest.id}:${p.enabled}:${p.status.state}`).join(";"),
  ];

  return parts.join("::");
};

/**
 * 提前解码封面图片，仅利用 Chromium 渲染引擎缓存
 */
const preloadCover = async (url: string): Promise<void> => {
  if (!url) return;
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
  } catch {
    // ignore
  }
};

/**
 * 作废当前的预载缓存
 */
export const invalidateNextTrackPreload = (): void => {
  currentToken++;
  cachedResult = null;
  currentContextKey = null;
};

/**
 * 消费预载结果
 * @param track - 正在切入播放的目标歌曲
 * @returns 匹配的预载结果，未命中或已作废则返回 null
 */
export const consumePreloadedTrack = (track: Track): NextTrackPreloadResult | null => {
  if (!cachedResult || cachedResult.trackId !== track.id) {
    return null;
  }
  const currentKey = buildContextKey(track);
  if (cachedResult.contextKey !== currentKey) {
    // 上下文已改变（如切换了音质），当前缓存作废
    invalidateNextTrackPreload();
    return null;
  }
  const result = cachedResult;
  invalidateNextTrackPreload();
  return result;
};

/**
 * 调度下一首预载任务
 */
export const scheduleNextTrackPreload = (): void => {
  const settings = useSettingsStore();
  if (!settings.player.preloadNextTrack) {
    invalidateNextTrackPreload();
    return;
  }

  const status = useStatusStore();
  const candidateResult = getNextTrackCandidate({
    playIndex: status.playIndex,
    queue: queue.queue.value,
    fmMode: status.fmMode,
    fuckDjMode: settings.preset.fuckDjMode,
  });

  if (!candidateResult) {
    invalidateNextTrackPreload();
    return;
  }

  const candidateTrack = candidateResult.track;
  const contextKey = buildContextKey(candidateTrack);

  // 上下文指纹一致且已有缓存，避免重复触发
  if (cachedResult && cachedResult.contextKey === contextKey) {
    return;
  }

  // 避免在异步生成过程中重复调度同一 contextKey
  if (currentContextKey === contextKey && !cachedResult) {
    return;
  }

  const token = ++currentToken;
  currentContextKey = contextKey;
  cachedResult = null;

  void (async () => {
    try {
      if (candidateTrack.cover) {
        void preloadCover(candidateTrack.cover);
      }

      const source = await resolveTrackSource(candidateTrack, { silent: true });

      if (token !== currentToken) {
        return;
      }

      cachedResult = {
        trackId: candidateTrack.id,
        source,
        contextKey,
      };
    } catch (err) {
      console.warn("[nextPreload] Preload task failed silently:", err);
      if (token === currentToken) {
        invalidateNextTrackPreload();
      }
    }
  })();
};

