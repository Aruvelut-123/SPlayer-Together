/**
 * KG 模块注册表
 */

import type { KGModule } from "../core/types";

import lyric from "./lyric";
import search from "./search";
import album from "./album";
import artist from "./artist";
import playlist from "./playlist";

export const modules: Record<string, KGModule> = {
  lyric,
  search,
  album,
  artist,
  playlist,
  song_list: playlist,
};
