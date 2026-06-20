/**
 * 听歌打卡
 *
 * 更新网易云听歌排行数据，需要登录态。
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const scrobble: NeteaseModule = async (query, request) => {
  if (typeof query.cookie === "object" && query.cookie) {
    query.cookie = { os: "osx", ...query.cookie };
  } else if (typeof query.cookie === "string") {
    query.cookie = query.cookie.includes("os=")
      ? query.cookie.replace(/os=[^;]+/g, "os=osx")
      : `${query.cookie}; os=osx`;
  } else {
    query.cookie = "os=osx";
  }

  const startplayData = {
    logs: JSON.stringify([
      {
        action: "startplay",
        json: {
          id: query.id,
          type: "song",
          mainsite: "1",
          mainsiteWeb: "1",
          content: `id=${query.sourceid}`,
        },
      },
    ]),
  };

  const playData = {
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
          mainsite: "1",
          mainsiteWeb: "1",
          content: `id=${query.sourceid}`,
        },
      },
    ]),
  };

  const option = createOption(query, "eapi");
  option.domain = "https://clientlog.music.163.com";

  const startplay = await request("/api/feedback/weblog", startplayData, option);
  const play = await request("/api/feedback/weblog", playData, option);

  return {
    status: 200,
    body: {
      code: 200,
      data: "success",
      details: {
        startplay: startplay.body,
        play: play.body,
      },
    },
    cookie: [],
  };
};

export default scrobble;
