/**
 * 云盘上传 - 发布到云盘
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const cloudPub: NeteaseModule = (query, request) => {
  const data = { songid: query.songid };
  return request("/api/cloud/pub/v2", data, createOption(query));
};

export default cloudPub;
