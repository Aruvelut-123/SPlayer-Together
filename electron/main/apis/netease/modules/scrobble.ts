/**
 * 听歌打卡
 *
 * 更新网易云听歌排行数据，需要登录态。
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const scrobble: NeteaseModule = (query, request) => {
  const data = {
    logs: JSON.stringify([
      {
        action: "play",
        json: {
          download: 0,
          end: "playend",
          id: query.id,
          sourceId: query.sourceid,
          time: query.time,
          type: "song",
          wifi: 0,
          source: "list",
          mainsite: 1,
          content: "",
        },
      },
    ]),
  };
  return request("/api/feedback/weblog", data, createOption(query, "weapi"));
};

export default scrobble;
