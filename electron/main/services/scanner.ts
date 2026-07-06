import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { JsScanEvent, JsScannedTrack } from "@splayer/audio-engine";
import { getEngine } from "./engine";
import {
  getAllTracks,
  upsertTracks,
  deleteTracksByPaths,
  getFileRecords,
  getCueTrackPathsByDirs,
  type UpsertTrack,
} from "@main/database";
import { broadcast } from "@main/utils/broadcast";
import { toCacheUrl } from "@main/utils/protocol";
import { toMs } from "@main/utils/time";
import { parseArtists, parseAlbum } from "@main/utils/metadata";
import { getCoverCacheDir } from "@main/utils/config";
import { libraryLog } from "@main/utils/logger";
import { getCueAudioPath, parseCueSheet } from "./cue";

let scanning = false;

/** 路径比较键，Windows 下保持大小写不敏感 */
const pathKey = (value: string): string => {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

/**
 * Rust 扫描/探测结果 → 数据库 Upsert 记录
 * id 由文件路径哈希生成，标签编辑回灌与扫描共用此规则
 */
export const scannedToUpsert = (track: JsScannedTrack): UpsertTrack => {
  const id = createHash("sha256").update(track.path).digest("hex").slice(0, 16);
  return {
    id,
    path: track.path,
    title: track.title || track.path.split(/[/\\]/).pop() || track.path,
    track: track.track,
    artists: parseArtists(track.artist ?? ""),
    album: parseAlbum(track.album ?? ""),
    duration: toMs(track.duration),
    cover: toCacheUrl(track.cover),
    codec: track.codec,
    sampleRate: track.sampleRate,
    bitRate: track.bitRate,
    channels: track.channels,
    bitsPerSample: track.bitsPerSample,
    fileSize: track.fileSize,
    mtime: track.mtime,
    ctime: track.ctime,
  };
};

/** 递归查找目录下的 CUE 文件 */
const findCueFiles = async (dirs: string[]): Promise<string[]> => {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      libraryLog.warn(`读取 CUE 目录失败 [${dir}]:`, error);
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".cue")) {
        files.push(fullPath);
      }
    }
  };
  for (const dir of dirs) await walk(dir);
  return files;
};

/** 同步 CUE 虚拟曲目到曲库 */
const syncCueTracks = async (dirs: string[]): Promise<number> => {
  const audioTracks = getAllTracks().filter((track) => track.source === "local" && !track.cuePath);
  const audioByPath = new Map(
    audioTracks.flatMap((track) => (track.path ? [[pathKey(track.path), track]] : [])),
  );
  const cueFiles = await findCueFiles(dirs);
  const upserts: UpsertTrack[] = [];
  const nextPaths = new Set<string>();

  for (const cuePath of cueFiles) {
    try {
      const cueStat = await fs.stat(cuePath);
      const content = await fs.readFile(cuePath, "utf8");
      const audioPath = getCueAudioPath(content, cuePath);
      if (!audioPath) continue;
      const audio = audioByPath.get(pathKey(audioPath));
      if (!audio || audio.duration <= 0) continue;
      const cueTracks = parseCueSheet(content, cuePath, audio.duration);
      for (const cueTrack of cueTracks) {
        const id = createHash("sha256").update(cueTrack.path).digest("hex").slice(0, 16);
        nextPaths.add(cueTrack.path);
        upserts.push({
          id,
          path: cueTrack.path,
          cuePath: cueTrack.cuePath,
          cueAudioPath: cueTrack.cueAudioPath,
          cueStartMs: cueTrack.cueStartMs,
          cueEndMs: cueTrack.cueEndMs,
          title: cueTrack.title,
          track: cueTrack.track,
          artists: cueTrack.artists,
          album: cueTrack.album,
          duration: cueTrack.duration,
          cover: audio.cover,
          codec: audio.quality?.codec,
          sampleRate: audio.quality?.sampleRate,
          bitRate: audio.quality?.bitRate,
          channels: audio.quality?.channels,
          bitsPerSample: audio.quality?.bitsPerSample,
          fileSize: audio.fileSize ?? cueStat.size,
          mtime: cueStat.mtimeMs,
          ctime: cueStat.ctimeMs,
        });
      }
    } catch (error) {
      libraryLog.warn(`解析 CUE 失败 [${cuePath}]:`, error);
    }
  }

  if (upserts.length > 0) upsertTracks(upserts);
  const stalePaths = getCueTrackPathsByDirs(dirs).filter((trackPath) => !nextPaths.has(trackPath));
  if (stalePaths.length > 0) deleteTracksByPaths(stalePaths);
  return upserts.length;
};

/** 完成 Rust 扫描后的收尾同步 */
const finishScan = async (dirs: string[], event: JsScanEvent): Promise<void> => {
  if (event.removedPaths && event.removedPaths.length > 0) {
    deleteTracksByPaths(event.removedPaths);
    libraryLog.info(`清理 ${event.removedPaths.length} 个已删除文件`);
  }
  const cueCount = await syncCueTracks(dirs);
  scanning = false;
  broadcast("library:scanProgress", {
    phase: "done",
    total: event.total,
    scanned: event.scanned,
  });
  libraryLog.info(`扫描完成: ${event.scanned}/${event.total} 个文件，CUE 分轨 ${cueCount} 首`);
};

/** 是否正在扫描 */
export const isScanning = (): boolean => scanning;

/**
 * 开始扫描
 * @param dirs 扫描目录列表
 * @param incremental 是否增量扫描（跳过未变化的文件）
 */
export const startScan = (dirs: string[], incremental = true): void => {
  if (scanning) {
    libraryLog.warn("已有扫描任务进行中，跳过");
    return;
  }
  if (dirs.length === 0) {
    libraryLog.warn("无扫描目录，跳过");
    return;
  }

  scanning = true;
  libraryLog.info(`开始扫描 ${dirs.length} 个目录 (增量=${incremental})`);

  // 增量扫描时传入已有文件记录，Rust 端会比对 mtime/size 跳过未变化的文件
  const incrementalData = incremental ? getFileRecords() : undefined;

  const engine = getEngine();
  engine.scanDirs(
    dirs,
    (event: JsScanEvent) => {
      switch (event.eventType) {
        case "progress": {
          // 已取消则丢弃滞后批次，避免写回已删除目录的曲目
          if (!scanning) break;
          // 批量写入数据库
          if (event.tracks && event.tracks.length > 0) {
            upsertTracks(event.tracks.map(scannedToUpsert));
          }
          broadcast("library:scanProgress", {
            phase: "scanning",
            total: event.total,
            scanned: event.scanned,
            current: event.current,
          });
          break;
        }
        case "done": {
          void finishScan(dirs, event).catch((error) => {
            scanning = false;
            libraryLog.error("扫描收尾失败:", error);
            broadcast("library:scanProgress", {
              phase: "done",
              total: event.total,
              scanned: event.scanned,
            });
          });
          break;
        }
      }
    },
    getCoverCacheDir(),
    incrementalData,
  );
};

/** 取消正在进行的扫描 */
export const cancelScan = (): void => {
  if (!scanning) return;
  const engine = getEngine();
  engine.cancelScan();
  scanning = false;
  libraryLog.info("已发送扫描取消信号");
};
