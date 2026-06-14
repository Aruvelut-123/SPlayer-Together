/**
 * 下载功能共享类型
 * 跨渲染层（解析 URL/歌词）与主进程（落盘/写标签）
 */

import type { Track } from "./player";
import type { LyricFormat } from "./lyrics";
import type { PluginQuality } from "./plugin";

/** 下载任务状态 */
export type DownloadStatus =
  | "queued"
  | "downloading"
  | "done"
  | "failed"
  | "canceled"
  | "interrupted";

/** 写入选项 */
export interface DownloadTagOptions {
  /** 内嵌封面 */
  embedCover: boolean;
  /** 内嵌标题/艺术家/专辑等元信息 */
  embedMeta: boolean;
  /** 内嵌歌词到标签 */
  embedLyric: boolean;
  /** 额外写同名 .lrc 文件 */
  writeLrc: boolean;
}

/** 渲染层 → 主进程的下载请求 */
export interface DownloadRequest {
  /** 渲染层生成的 UUID */
  taskId: string;
  track: Track;
  qualityLevel: PluginQuality;
  /** 已解析的音频 URL */
  url: string;
  /** 已知格式（netease 的 flac/mp3），用于确定扩展名 */
  declaredFormat?: string;
  /** 已知体积（字节），进度兜底 */
  declaredSize?: number;
  /** 封面原图 URL，主进程按需 fetch 内嵌 */
  coverUrl?: string;
  /** 歌词文本 */
  lyricText?: string;
  /** 歌词格式 */
  lyricFormat?: LyricFormat;
  tagOptions: DownloadTagOptions;
}

/** 主进程持有的下载任务 */
export interface DownloadTask {
  taskId: string;
  status: DownloadStatus;
  track: Track;
  qualityLevel: PluginQuality;
  /** 已接收字节 */
  received: number;
  /** 总字节（未知为 0） */
  total: number;
  /** 完成后最终文件路径 */
  filePath?: string;
  /** 失败原因码 */
  errorCode?: string;
  /** 写标签失败但音频已落盘 */
  tagWarning?: boolean;
  createdAt: number;
  finishedAt?: number;
}

/** 下载进度推送 */
export interface DownloadProgress {
  taskId: string;
  received: number;
  total: number;
}

/** 入队结果；ok 为 false 时 reason 说明原因 */
export interface EnqueueResult {
  ok: boolean;
  /** queued=同曲同音质已在队列/下载中；downloaded=已下载过且文件仍在 */
  reason?: "queued" | "downloaded";
}

/** 渲染端下载 IPC 入口 */
export interface DownloadApi {
  start: (req: DownloadRequest) => Promise<EnqueueResult>;
  cancel: (taskId: string) => Promise<void>;
  retry: (req: DownloadRequest) => Promise<EnqueueResult>;
  remove: (taskId: string) => Promise<void>;
  clearFinished: () => Promise<void>;
  list: () => Promise<DownloadTask[]>;
  pickDir: () => Promise<{ ok: boolean; dir: string; reason?: "canceled" }>;
  getDir: () => Promise<string>;
  resetDir: () => Promise<string>;
  onProgress: (callback: (data: DownloadProgress) => void) => () => void;
  onState: (callback: (task: DownloadTask) => void) => () => void;
}
