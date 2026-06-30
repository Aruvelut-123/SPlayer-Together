/**
 * QRC 逐字歌词解析器
 *
 * 格式（解密后）：
 *   [start_ms,dur_ms]文字(start_ms,dur_ms)文字(start_ms,dur_ms)...
 *   - 行头 [起始, 时长]（绝对毫秒）
 *   - 字级 文字(绝对起始, 时长)
 *
 * 额外支持 XML 包裹：`LyricContent="..."` 属性 或 `<![CDATA[...]]>` 段
 */

import type { LyricLine, LyricWord } from "@shared/types/lyrics";
import { detectBackgroundLine, splitTrailingBackground } from "./bg";

/** 行头：[起始毫秒, 时长毫秒] */
const LINE_HEADER_RE = /^\[(\d+),(\d+)\]/;

/** 字级：文字(起始毫秒, 时长毫秒) */
const WORD_RE = /([^(]+)\((\d+),(\d+)\)/g;

/** 从 XML 包裹中提取纯文本歌词内容（非 XML 原样返回） */
const extractFromXml = (text: string): string => {
  if (!text.trimStart().startsWith("<")) return text;
  const greedyMatch = text.match(/LyricContent="([\s\S]*)"\s*\/?>/);
  if (greedyMatch) return greedyMatch[1];
  const cdataMatch = text.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (cdataMatch) return cdataMatch[1];
  const attrMatch = text.match(/LyricContent="([^"]*)"/);
  if (attrMatch) return attrMatch[1];
  return text;
};

/** 解析 QRC 歌词 */
export const parseQRC = (text: string): LyricLine[] => {
  const content = extractFromXml(text);
  const lines: LyricLine[] = [];

  for (const raw of content.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const header = LINE_HEADER_RE.exec(trimmed);
    if (!header) continue;

    const lineStart = parseInt(header[1], 10);
    const lineDur = parseInt(header[2], 10);
    const rest = trimmed.slice(header[0].length);

    WORD_RE.lastIndex = 0;
    const words: LyricWord[] = [];
    let match: RegExpExecArray | null;
    while ((match = WORD_RE.exec(rest)) !== null) {
      const start = parseInt(match[2], 10);
      const dur = parseInt(match[3], 10);
      words.push({ word: match[1], startTime: start, endTime: start + dur });
    }

    if (words.length === 0) continue;

    const line: LyricLine = {
      words,
      translatedLyric: "",
      romanLyric: "",
      startTime: lineStart,
      endTime: lineStart + lineDur,
      isBG: detectBackgroundLine(words),
      isDuet: false,
    };
    lines.push(line);
    // 行内尾随和声「主歌词（和声）」拆成紧随的背景行
    if (!line.isBG) {
      const bg = splitTrailingBackground(line);
      if (bg) lines.push(bg);
    }
  }

  return lines;
};
