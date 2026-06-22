/**
 * 云盘上传 - 提交歌曲信息
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const cloudUploadInfo: NeteaseModule = (query, request) => {
  const data = {
    md5: query.md5,
    songid: query.songid,
    filename: query.filename,
    song: query.song,
    album: query.album ?? "未知专辑",
    artist: query.artist ?? "未知艺术家",
    bitrate: "999000",
    resourceId: query.resourceId,
  };
  return request("/api/upload/cloud/info/v2", data, createOption(query));
};

export default cloudUploadInfo;
