import type { Track } from "@shared/types/player";
import type { NeteaseScrobbleMode } from "@shared/types/settings";
import { store } from "@main/store";
import { callNetease, getNeteaseCookies } from "@main/apis/netease";
import { neteaseLog } from "@main/utils/logger";

interface NeteaseScrobbleTrack {
  id: string;
  sourceId: string;
  title: string;
  artist: string;
  bitrate: number;
  level: string;
  durationSec: number;
}

/** 时长低于该值不打卡 */
const SCROBBLE_MIN_DURATION_SEC = 30;
/** 打卡最长等待：min(时长一半, 240s) */
const SCROBBLE_MAX_WAIT_SEC = 240;

let current: NeteaseScrobbleTrack | null = null;
/** 最近一次加载的可打卡曲目 */
let loaded: NeteaseScrobbleTrack | null = null;
/** 暂停前已累计的播放毫秒 */
let playedMs = 0;
/** 本段播放开始的墙钟时间戳；未在播放时为 null */
let playSince: number | null = null;
/** 当前曲目是否已尝试打卡 */
let attempted = false;
/** 上一次收到的源时间位置 */
let lastPositionMs = 0;
/** 当前播放轮次，用于丢弃旧请求回包 */
let cycleId = 0;

/** 当前累计实际播放毫秒 */
const elapsedMs = (): number => playedMs + (playSince != null ? Date.now() - playSince : 0);

/** 当前曲目的打卡阈值 */
const thresholdMs = (track: NeteaseScrobbleTrack): number =>
  Math.min(track.durationSec / 2, SCROBBLE_MAX_WAIT_SEC) * 1000;

/** 是否看起来是网易云登录态 */
const isLoggedIn = (): boolean => Boolean(getNeteaseCookies().MUSIC_U);

/** 提取接口可接受的数字 id */
const asNumericId = (value: string | undefined): string | null =>
  value && /^\d+$/.test(value) ? value : null;

/** NCBL 日志使用桌面客户端的音质字段 */
const toNcblBitrate = (track: Track): number => {
  const bitRate = track.quality?.bitRate ?? 320;
  return bitRate > 10000 ? Math.round(bitRate / 1000) : Math.round(bitRate);
};

/** NCBL 日志使用网易云音质等级 */
const toNcblLevel = (track: Track): string => {
  if (track.quality?.codec?.toLowerCase() === "flac") return "lossless";
  if ((track.quality?.bitRate ?? 0) >= 320000) return "exhigh";
  return "higher";
};

/** 当前配置启用的上报接口 */
const scrobbleApi = (): string => {
  const mode = (store.get("system.neteaseScrobbleMode") || "ncbl") as NeteaseScrobbleMode;
  return mode === "ncbl" ? "scrobble_v1" : "scrobble";
};

/** 检查接口业务码 */
const ensureScrobbleOk = (api: string, res: { body: any }): void => {
  if (res.body?.code === 200 || res.body?.data === "success") return;
  const msg = res.body?.msg || res.body?.message || JSON.stringify(res.body);
  throw new Error(`${api}: ${msg}`);
};

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
    artist: track.artists.map((artist) => artist.name).join(" / "),
    bitrate: toNcblBitrate(track),
    level: toNcblLevel(track),
    durationSec,
  };
};

/** 达标则提交一次听歌打卡 */
const maybeSubmit = (): void => {
  if (!current || attempted) return;
  const playedMsNow = elapsedMs();
  if (playedMsNow < thresholdMs(current)) return;
  attempted = true;
  if (!isLoggedIn()) return;
  const track = current;
  const requestCycleId = cycleId;
  const playedSec = Math.max(1, Math.min(track.durationSec, Math.round(playedMsNow / 1000)));
  const api = scrobbleApi();
  callNetease(api, {
    id: track.id,
    sourceid: track.sourceId,
    time: playedSec,
    total: track.durationSec,
    name: track.title,
    artist: track.artist,
    bitrate: track.bitrate,
    level: track.level,
  })
    .then((res) => {
      ensureScrobbleOk(api, res);
      if (requestCycleId === cycleId) neteaseLog.debug(`听歌打卡(${api}): ${track.title}`);
    })
    .catch((err) => {
      if (requestCycleId === cycleId) neteaseLog.warn(`听歌打卡失败(${api}):`, err);
    });
};

/** 重置本轮播放状态 */
const resetCycle = (): void => {
  cycleId++;
  current = null;
  playedMs = 0;
  playSince = null;
  attempted = false;
  lastPositionMs = 0;
};

/** 开启一轮播放 */
const beginCycle = (autoPlay: boolean): void => {
  cycleId++;
  current = loaded;
  playedMs = 0;
  attempted = false;
  lastPositionMs = 0;
  playSince = current && autoPlay ? Date.now() : null;
};

/** 结算当前播放轮次，切歌/结束前补一次达标检查 */
const flush = (): void => {
  if (playSince != null) {
    playedMs += Date.now() - playSince;
    playSince = null;
  }
  maybeSubmit();
  resetCycle();
};

/**
 * 新曲目加载
 * @param track - 渲染层下发的权威 Track
 * @param durationMs - 引擎确认后的时长
 * @param autoPlay - 是否自动播放
 */
export const onTrackLoaded = (track: Track | null, durationMs: number, autoPlay: boolean): void => {
  flush();
  loaded = toScrobbleTrack(track, durationMs);
  beginCycle(autoPlay);
};

/**
 * 播放/暂停状态变化
 * @param playing - 是否正在播放
 */
export const onState = (playing: boolean): void => {
  if (!current) return;
  if (playing) {
    if (playSince == null) playSince = Date.now();
  } else {
    if (playSince != null) {
      playedMs += Date.now() - playSince;
      playSince = null;
    }
    maybeSubmit();
  }
};

/**
 * 播放进度推进
 * @param positionMs - 当前源时间位置
 */
export const onPosition = (positionMs: number): void => {
  if (current && attempted) {
    const limit = thresholdMs(current);
    const returnedBeforeThreshold = lastPositionMs >= limit && positionMs < limit;
    const jumpedBack = positionMs + 1000 < lastPositionMs;
    if (positionMs < limit && (returnedBeforeThreshold || jumpedBack)) {
      beginCycle(playSince != null);
    }
  }
  lastPositionMs = positionMs;
  maybeSubmit();
};

/** 自然播放结束 */
export const onEnded = (): void => {
  flush();
  beginCycle(false);
};
