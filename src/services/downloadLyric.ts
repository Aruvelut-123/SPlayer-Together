/**
 * 下载歌词解析
 *
 * 取歌曲歌词文本（用于内嵌到标签 / 写 .lrc）。来源在渲染层，因此在入队前解析好带给主进程。
 */

import type { Track } from "@shared/types/player";
import type { LyricFormat } from "@shared/types/lyrics";
import { isPlatform } from "@shared/types/platform";
import { useStreamingStore } from "@/stores/streaming";
import { detectFormat } from "@/utils/lyric/parse";

/** 下载用歌词 */
export interface DownloadLyric {
  content: string;
  format: LyricFormat;
  /** 翻译原文 */
  translation?: string;
  translationFormat?: LyricFormat;
  /** 音译原文 */
  romaji?: string;
  romajiFormat?: LyricFormat;
}

/**
 * 取歌曲歌词文本
 * @param track - 歌曲
 * @returns 歌词文本与格式；无歌词返回 null
 */
export const resolveDownloadLyric = async (track: Track): Promise<DownloadLyric | null> => {
  // 流媒体
  if (track.source === "streaming") {
    const text = await useStreamingStore().getLyrics(track);
    if (text && text.trim()) return { content: text, format: detectFormat(text) };
    return null;
  }
  // 在线平台：按 id 直取
  if (isPlatform(track.source)) {
    const lookupId = track.source === "qqmusic" ? (track.extId ?? track.id) : track.id;
    const resp = await window.api.lyrics.matchById(track.source, lookupId);
    if (resp.ok && resp.data?.content) {
      return {
        content: resp.data.content,
        format: resp.data.format,
        translation: resp.data.translation,
        translationFormat: resp.data.translationFormat,
        romaji: resp.data.romaji,
        romajiFormat: resp.data.romajiFormat,
      };
    }
  }
  return null;
};
