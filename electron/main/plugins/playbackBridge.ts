/**
 * 控制类插件的播放事件桥
 */

import type { Track } from "@shared/types/player";
import type { LyricLine } from "@shared/types/lyrics";
import type {
  NowPlayingSnapshot,
  NowPlayingPositionSync,
  NowPlayingLyricOffsetSync,
} from "@shared/types/nowPlaying";
import * as nowPlaying from "@main/services/nowPlaying";
import { pluginRegistry } from "./registry";

let lyricLines: LyricLine[] = [];
let currentIndex = -1;
let lyricOffsetMs = 0;
let lastPlaying = false;
let unsubscribers: Array<() => void> = [];
/** 移除注册表 controlActivityChange 监听的句柄 */
let offControlActivity: (() => void) | null = null;

/** Track → 插件可见的精简载荷 */
const trackPayload = (track: Track | null) =>
  track
    ? {
        title: track.title,
        artists: track.artists.map((artist) => artist.name).join(", "),
        album: track.album?.name,
        duration: track.duration,
        cover: track.cover,
      }
    : null;

/** 找 startTime <= time 的最后一行 */
const findIndex = (time: number): number => {
  let result = -1;
  for (let index = 0; index < lyricLines.length; index++) {
    if (lyricLines[index].startTime <= time) result = index;
    else break;
  }
  return result;
};

const onTrackChange = (data: { track: Track | null }): void => {
  lyricLines = [];
  currentIndex = -1;
  pluginRegistry.broadcastPlaybackEvent("trackChange", { track: trackPayload(data.track) });
};

const onLyricChange = (snap: NowPlayingSnapshot): void => {
  lyricLines = snap.lyric;
  currentIndex = -1;
  lyricOffsetMs = snap.lyricOffsetMs;
  pluginRegistry.broadcastPlaybackEvent("lyricChange", { lines: lyricLines });
};

const onLyricOffsetChange = (data: NowPlayingLyricOffsetSync): void => {
  lyricOffsetMs = data.offsetMs;
};

const onPositionSync = (data: NowPlayingPositionSync): void => {
  if (data.playing !== lastPlaying) {
    lastPlaying = data.playing;
    pluginRegistry.broadcastPlaybackEvent("playStateChange", {
      state: data.playing ? "playing" : "paused",
      position: data.position,
    });
  }
  if (lyricLines.length === 0) return;
  const next = findIndex(data.position + lyricOffsetMs);
  if (next === currentIndex) return;
  currentIndex = next;
  pluginRegistry.broadcastPlaybackEvent("lineChange", { index: next, position: data.position });
};

/** 挂载时立即获取一次 */
const prime = (): void => {
  const snap = nowPlaying.snapshot();
  lyricLines = snap.lyric;
  lyricOffsetMs = snap.lyricOffsetMs;
  lastPlaying = snap.playing;
  pluginRegistry.broadcastPlaybackEvent("trackChange", { track: trackPayload(snap.track) });
  pluginRegistry.broadcastPlaybackEvent("lyricChange", { lines: lyricLines });
  pluginRegistry.broadcastPlaybackEvent("playStateChange", {
    state: snap.playing ? "playing" : "paused",
    position: snap.position,
  });
  currentIndex = lyricLines.length > 0 ? findIndex(snap.position + lyricOffsetMs) : -1;
  if (currentIndex >= 0) {
    pluginRegistry.broadcastPlaybackEvent("lineChange", {
      index: currentIndex,
      position: snap.position,
    });
  }
};

/** 挂载所有 nowPlaying 订阅 */
const attach = (): void => {
  if (unsubscribers.length > 0) return;
  unsubscribers = [
    nowPlaying.onTrackChange(onTrackChange),
    nowPlaying.onLyricChange(onLyricChange),
    nowPlaying.onLyricOffsetChange(onLyricOffsetChange),
    nowPlaying.onPositionSync(onPositionSync),
  ];
  prime();
};

/** 卸载订阅并清空状态 */
const detach = (): void => {
  for (const unsub of unsubscribers) {
    try {
      unsub();
    } catch {
      /* ignore */
    }
  }
  unsubscribers = [];
  lyricLines = [];
  currentIndex = -1;
  lyricOffsetMs = 0;
  lastPlaying = false;
};

/** 启动：按当前是否有控制类插件惰性挂载，并随其增减切换 */
export const init = (): void => {
  if (pluginRegistry.hasEnabledControlPlugin()) attach();
  const onControlActivity = (active: boolean): void => (active ? attach() : detach());
  pluginRegistry.on("controlActivityChange", onControlActivity);
  offControlActivity = () => pluginRegistry.off("controlActivityChange", onControlActivity);
};

/** 关闭 */
export const dispose = (): void => {
  offControlActivity?.();
  offControlActivity = null;
  detach();
};
