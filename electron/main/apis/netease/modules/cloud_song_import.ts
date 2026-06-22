/**
 * 云盘导入:把已匹配的歌曲落库到我的云盘
 */

import { createOption } from "../core/option";
import type { NeteaseModule } from "../core/types";

const cloudSongImport: NeteaseModule = (query, request) => {
  const data = {
    uploadType: 0,
    songs: JSON.stringify([
      {
        songId: query.songId,
        bitrate: 999000,
        song: query.song,
        artist: query.artist ?? "未知艺术家",
        album: query.album ?? "未知专辑",
        fileName: `${query.song}.${query.fileType}`,
      },
    ]),
  };
  return request("/api/cloud/user/song/import", data, createOption(query));
};

export default cloudSongImport;
