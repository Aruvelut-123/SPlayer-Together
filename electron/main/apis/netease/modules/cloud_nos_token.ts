/**
 * 云盘上传 - 申请 NOS 上传 token
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const cloudNosToken: NeteaseModule = (query, request) => {
  const data = {
    bucket: "jd-musicrep-privatecloud-audio-public",
    ext: query.ext,
    filename: query.filename,
    local: false,
    nos_product: 3,
    type: "audio",
    md5: query.md5,
  };
  return request("/api/nos/token/alloc", data, createOption(query, "weapi"));
};

export default cloudNosToken;
