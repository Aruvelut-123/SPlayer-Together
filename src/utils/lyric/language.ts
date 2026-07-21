/** Han 脚本无法区分中日及简繁体，调用方不能把仅含汉字的结果视为确定语言。 */

/** 歌词语言代码（BCP 47 子集） */
export type LyricLanguage = "ja" | "ko" | "zh-CN" | "en";

/** 日语假名：平假名 + 片假名 + 半角假名 + 促音/长音符号 */
const KANA_RE = /[\p{Script=Hiragana}\p{Script=Katakana}\u30FC\uFF66-\uFF9F]/u;

/** 韩文：谚文音节 + 谚文字母 + 谚文兼容字母 */
const HANGUL_RE = /[\p{Script=Hangul}\u3130-\u318F]/u;

/** 中日韩统一表意文字（含扩展 A 区） */
const HAN_RE = /\p{Script=Han}/u;

/**
 * 检测歌词语言
 * @param lyric - 歌词内容（通常为一行主歌词合并后的文本）
 * @returns 语言代码：`"ja"` | `"ko"` | `"zh-CN"` | `"en"`
 */
export const getLyricLanguage = (lyric: string): LyricLanguage => {
  if (!lyric || typeof lyric !== "string") return "en";
  // 日语：含假名即判定（汉字+假名混排是日语歌词的典型形态）
  if (KANA_RE.test(lyric)) return "ja";
  // 韩语：含谚文音节
  if (HANGUL_RE.test(lyric)) return "ko";
  // 中文：含汉字（简繁不区分）
  if (HAN_RE.test(lyric)) return "zh-CN";
  // 默认英语（覆盖拉丁、西里尔、阿拉伯等其余情况）
  return "en";
};
