/**
 * 云盘上传 - 文件查重(秒传判定)
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const cloudUploadCheck: NeteaseModule = (query, request) => {
  const data = {
    bitrate: "999000",
    ext: "",
    length: query.length,
    md5: query.md5,
    songId: "0",
    version: 1,
  };
  return request("/api/cloud/upload/check", data, createOption(query));
};

export default cloudUploadCheck;
