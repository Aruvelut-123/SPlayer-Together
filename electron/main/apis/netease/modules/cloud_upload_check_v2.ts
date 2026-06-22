/**
 * 云盘秒传查重 v2:判断已在曲库的文件能否导入
 * 返回 data[0].upload:0 可导入 / 1 已在云盘 / 2 不可导入
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const cloudUploadCheckV2: NeteaseModule = (query, request) => {
  const data = {
    uploadType: 0,
    songs: JSON.stringify([
      { md5: query.md5, songId: query.songId ?? -2, bitrate: 999000, fileSize: query.fileSize },
    ]),
  };
  return request("/api/cloud/upload/check/v2", data, createOption(query));
};

export default cloudUploadCheckV2;
