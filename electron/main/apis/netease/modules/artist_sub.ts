/**
 * 收藏 / 取消收藏歌手
 *
 * params:
 * - id 歌手 id
 * - t  1 收藏 / 2 取消，默认 1
 *
 * 响应：`{ code }`
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const artistSub: NeteaseModule = (query, request) => {
  const path = query.t === 2 ? "/api/artist/unsub" : "/api/artist/sub";
  const data = { artistId: query.id, artistIds: `[${query.id}]` };
  return request(path, data, createOption(query, "weapi"));
};

export default artistSub;
