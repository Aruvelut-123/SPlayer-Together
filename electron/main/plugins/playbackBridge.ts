/**
 * 控制类插件的播放事件桥
 *
 * 订阅 nowPlaying 总线，集中算出当前歌词行（只算一次），把高层语义事件
 * 扇出给已启用的控制类插件。position-sync(5Hz) 只在本进程消费，仅行索引
 * 变化才向插件下发，避免 5Hz IPC 外泄。
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
let unsubscribers: Array<() => void> = [];

/** 拼一行歌词纯文本 */
const lineToText = (line: LyricLine): string => line.words.map((word) => word.word).join("");

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
  const track = data.track;
  pluginRegistry.broadcastPlaybackEvent("trackChange", {
    track: track
      ? {
          title: track.title,
          artists: track.artists.map((artist) => artist.name).join(", "),
          album: track.album?.name,
          duration: track.duration,
          cover: track.cover,
        }
      : null,
  });
};

const onLyricChange = (snap: NowPlayingSnapshot): void => {
  lyricLines = snap.lyric;
  currentIndex = -1;
  lyricOffsetMs = snap.lyricOffsetMs;
};

const onLyricOffsetChange = (data: NowPlayingLyricOffsetSync): void => {
  lyricOffsetMs = data.offsetMs;
};

const onPositionSync = (data: NowPlayingPositionSync): void => {
  if (lyricLines.length === 0) return;
  const time = data.position + lyricOffsetMs;
  const next = findIndex(time);
  if (next === currentIndex) return;
  currentIndex = next;
  const current = next >= 0 ? lyricLines[next] : null;
  const nextLine = next + 1 < lyricLines.length ? lyricLines[next + 1] : null;
  pluginRegistry.broadcastPlaybackEvent("lyricLineChange", {
    index: next,
    current: current
      ? { text: lineToText(current), translation: current.translatedLyric || undefined }
      : null,
    next: nextLine ? { text: lineToText(nextLine) } : null,
    time,
  });
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
};

/** 启动：按当前是否有控制类插件惰性挂载，并随其增减切换 */
export const init = (): void => {
  if (pluginRegistry.hasEnabledControlPlugin()) attach();
  pluginRegistry.on("controlActivityChange", (active: boolean) => {
    if (active) attach();
    else detach();
  });
};

/** 关闭 */
export const dispose = (): void => {
  detach();
};
