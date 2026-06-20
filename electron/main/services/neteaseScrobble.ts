import type { Track } from "@shared/types/player";
import { callNetease, getNeteaseCookies } from "@main/apis/netease";
import { neteaseLog } from "@main/utils/logger";

interface NeteaseScrobbleTrack {
  id: string;
  sourceId: string;
  title: string;
  durationSec: number;
}

/** 时长低于该值不打卡 */
const SCROBBLE_MIN_DURATION_SEC = 30;
/** 打卡最长等待：min(时长一半, 240s) */
const SCROBBLE_MAX_WAIT_SEC = 240;

let current: NeteaseScrobbleTrack | null = null;
/** 暂停前已累计的播放毫秒 */
let playedMs = 0;
/** 本段播放开始的墙钟时间戳；未在播放时为 null */
let playSince: number | null = null;
/** 当前曲目是否已尝试打卡 */
let attempted = false;

/** 当前累计实际播放毫秒 */
const elapsedMs = (): number => playedMs + (playSince != null ? Date.now() - playSince : 0);

/** 是否看起来是网易云登录态 */
const isLoggedIn = (): boolean => Boolean(getNeteaseCookies().MUSIC_U);

/** 提取接口可接受的数字 id */
const asNumericId = (value: string | undefined): string | null =>
  value && /^\d+$/.test(value) ? value : null;

/** 从 Track 生成打卡元数据 */
const toScrobbleTrack = (track: Track | null, durationMs: number): NeteaseScrobbleTrack | null => {
  if (!track || track.source !== "netease") return null;
  const id = asNumericId(track.id);
  const sourceId = asNumericId(track.album?.id);
  if (!id || !sourceId) return null;
  const durationSec = Math.round(durationMs / 1000);
  if (durationSec <= SCROBBLE_MIN_DURATION_SEC) return null;
  return {
    id,
    sourceId,
    title: track.title,
    durationSec,
  };
};

/** 达标则提交一次听歌打卡 */
const maybeSubmit = (): void => {
  if (!current || attempted) return;
  const thresholdMs = Math.min(current.durationSec / 2, SCROBBLE_MAX_WAIT_SEC) * 1000;
  const playedMsNow = elapsedMs();
  if (playedMsNow < thresholdMs) return;
  attempted = true;
  if (!isLoggedIn()) return;
  const track = current;
  const playedSec = Math.max(1, Math.min(track.durationSec, Math.round(playedMsNow / 1000)));
  callNetease("scrobble", {
    id: track.id,
    sourceid: track.sourceId,
    time: playedSec,
  })
    .then(() => neteaseLog.debug(`听歌打卡: ${track.title}`))
    .catch((err) => neteaseLog.warn("听歌打卡失败:", err));
};

/** 结算当前曲目，切歌/结束前补一次达标检查 */
const flush = (): void => {
  if (playSince != null) {
    playedMs += Date.now() - playSince;
    playSince = null;
  }
  maybeSubmit();
  current = null;
  playedMs = 0;
  attempted = false;
};

/**
 * 新曲目加载
 * @param track - 渲染层下发的权威 Track
 * @param durationMs - 引擎确认后的时长
 * @param autoPlay - 是否自动播放
 */
export const onTrackLoaded = (track: Track | null, durationMs: number, autoPlay: boolean): void => {
  flush();
  current = toScrobbleTrack(track, durationMs);
  playedMs = 0;
  attempted = false;
  playSince = current && autoPlay ? Date.now() : null;
};

/**
 * 播放/暂停状态变化
 * @param playing - 是否正在播放
 */
export const onState = (playing: boolean): void => {
  if (!current) return;
  if (playing) {
    if (playSince == null) playSince = Date.now();
  } else if (playSince != null) {
    playedMs += Date.now() - playSince;
    playSince = null;
  }
};

/** 播放进度推进 */
export const onPosition = (): void => {
  maybeSubmit();
};

/** 自然播放结束 */
export const onEnded = (): void => {
  flush();
};
