/**
 * 云盘上传编排(客户端直传)
 *
 * 查重后按 needUpload 分流
 * - 需真上传:申请 token → 取 NOS 服务器 → 流式直传 → 提交信息 → 发布
 * - 秒传(文件已在网易曲库):走导入接口(check/v2 + user/song/import),不申请 token、不传字节
 */

import http from "node:http";
import https from "node:https";
import path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { callNetease } from "@main/apis/netease";
import { getEngine } from "@main/services/engine";
import { cloudLog } from "@main/utils/logger";
import type { CloudUploadResult, CloudUploadStage } from "@shared/types/cloudUpload";

/** 私有云盘音频 bucket */
const BUCKET = "jd-musicrep-privatecloud-audio-public";
/** 扩展名 → Content-Type */
const MIME_BY_EXT: Record<string, string> = {
  mp3: "audio/mpeg",
  flac: "audio/flac",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  wma: "audio/x-ms-wma",
  ape: "audio/x-ape",
  aiff: "audio/aiff",
};

/** 进度回调形态 */
type ProgressFn = (progress: { stage: CloudUploadStage; loaded: number; total: number }) => void;

/**
 * 流式计算文件 md5(十六进制)
 * @param filePath - 文件绝对路径
 */
const fileMd5 = (filePath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash("md5");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });

/** 取 NOS 上传服务器地址 */
const fetchUploadHost = async (): Promise<string> => {
  const res = await fetch(`https://wanproxy.127.net/lbs?version=1.0&bucketname=${BUCKET}`, {
    signal: AbortSignal.timeout(10000),
  });
  const data = (await res.json()) as { upload?: string[] };
  const host = data.upload?.[0];
  if (!host) throw new Error("获取上传服务器地址失败");
  return host;
};

/**
 * 把文件字节流式 POST 到 NOS,边传边回报已传字节
 * @param uploadUrl - 完整上传地址
 * @param filePath - 文件绝对路径
 * @param fileSize - 文件字节数(Content-Length)
 * @param token - x-nos-token
 * @param md5 - 十六进制 md5(Content-MD5)
 * @param mime - Content-Type
 * @param onBytes - 已传字节回调
 */
const uploadToNos = (
  uploadUrl: string,
  filePath: string,
  fileSize: number,
  token: string,
  md5: string,
  mime: string,
  onBytes: (loaded: number) => void,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const url = new URL(uploadUrl);
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(
      url,
      {
        method: "POST",
        headers: {
          "x-nos-token": token,
          "Content-MD5": md5,
          "Content-Type": mime,
          "Content-Length": String(fileSize),
        },
        timeout: 300000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) resolve();
          else reject(new Error(`NOS ${status}: ${Buffer.concat(chunks).toString()}`));
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("NOS 上传超时")));

    let loaded = 0;
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        loaded += chunk.length;
        onBytes(loaded);
        callback(null, chunk);
      },
    });
    void pipeline(createReadStream(filePath), counter, req).catch(reject);
  });

/**
 * 上传单首歌曲到云盘
 * @param filePath - 本地文件绝对路径
 * @param onProgress - 阶段/字节进度回调
 * @returns 上传结果(含是否秒传、songId)
 */
export const uploadCloudSong = async (
  filePath: string,
  onProgress: ProgressFn,
): Promise<CloudUploadResult> => {
  const info = await stat(filePath);
  const fileSize = info.size;
  const fullName = path.basename(filePath);
  const ext = path.extname(fullName).slice(1).toLowerCase() || "mp3";
  const baseName = fullName.replace(/\.[^.]+$/, "");
  const mime = MIME_BY_EXT[ext] ?? "audio/mpeg";

  onProgress({ stage: "checking", loaded: 0, total: fileSize });
  const md5 = await fileMd5(filePath);

  let title = baseName;
  let artist = "未知艺术家";
  let album = "未知专辑";
  try {
    const tags = await getEngine().readTrackTags(filePath);
    if (tags.title) title = tags.title;
    if (tags.artist) artist = tags.artist;
    if (tags.album) album = tags.album;
  } catch (err) {
    cloudLog.warn(`读取标签失败,使用默认信息: ${fullName}`, err);
  }

  const checkRes = await callNetease("cloud_upload_check", {
    md5,
    length: fileSize,
  });
  const needUpload = Boolean(checkRes.body?.needUpload);
  const checkSongId = checkRes.body?.songId;
  cloudLog.info(`查重完成: ${fullName} needUpload=${needUpload} songId=${checkSongId}`);

  // 秒传:文件已在曲库,走导入接口落库,不申请 token、不传字节
  if (!needUpload) {
    onProgress({ stage: "finishing", loaded: fileSize, total: fileSize });
    const checkV2 = await callNetease("cloud_upload_check_v2", {
      md5,
      fileSize,
    });
    const matched = checkV2.body?.data?.[0];
    cloudLog.info(`秒传查重: ${fullName} upload=${matched?.upload} songId=${matched?.songId}`);
    if (!matched?.songId) throw new Error("秒传查重失败");
    const importRes = await callNetease("cloud_song_import", {
      songId: matched.songId,
      song: title,
      artist,
      album,
      fileType: ext,
    });
    cloudLog.info(`秒传导入完成: ${fullName} code=${importRes.body?.code}`);
    return { success: true, instant: true, songId: String(matched.songId) };
  }

  // 需真上传:申请 token → 取 NOS 服务器 → 流式直传 → 提交信息 → 发布
  const tokenRes = await callNetease("cloud_nos_token", {
    ext,
    filename: baseName.replace(/\s/g, "").replace(/\./g, "_"),
    md5,
  });
  const result = tokenRes.body?.result;
  if (!result?.objectKey || !result?.token) throw new Error("获取上传 token 失败");
  const { token, objectKey, resourceId } = result;

  onProgress({ stage: "uploading", loaded: 0, total: fileSize });
  const uploadHost = await fetchUploadHost();
  const objectPath = String(objectKey).replace(/\//g, "%2F");
  const uploadUrl = `${uploadHost}/${BUCKET}/${objectPath}?offset=0&complete=true&version=1.0`;
  await uploadToNos(uploadUrl, filePath, fileSize, token, md5, mime, (loaded) =>
    onProgress({ stage: "uploading", loaded, total: fileSize }),
  );

  onProgress({ stage: "finishing", loaded: fileSize, total: fileSize });
  const infoRes = await callNetease("cloud_upload_info", {
    md5,
    songid: checkSongId,
    filename: fullName,
    song: title,
    album,
    artist,
    resourceId,
  });
  const songId = infoRes.body?.songId;
  if (songId == null) throw new Error("提交云盘信息失败");
  await callNetease("cloud_pub", { songid: songId });
  cloudLog.info(`上传发布完成: ${fullName} songId=${songId}`);

  return {
    success: true,
    instant: false,
    songId: String(songId),
  };
};
