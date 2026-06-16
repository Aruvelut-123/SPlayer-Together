/**
 * 获取歌曲下载地址（v1 端点，官方「客户端下载」接口）
 *
 * params:
 * - id     歌曲 id（单个）
 * - level  音质 level，默认 exhigh
 *          standard / exhigh / lossless / hires / jyeffect / sky / jymaster
 *
 * 响应：`{ code, data: { id, url, br, size, type, level, ... } }`
 * - url == null：无下载权限 / 版权未开放
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const song_download_url: NeteaseModule = (query, request) => {
  const data = {
    id: query.id,
    level: query.level ?? "exhigh",
  };
  return request("/api/song/enhance/download/url/v1", data, createOption(query));
};

export default song_download_url;
