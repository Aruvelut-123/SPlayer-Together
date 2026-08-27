use std::collections::HashMap;

use ffmpeg_audio::SourceAudioInfo;

mod cover;
mod editor;
mod folder_cover;
mod lyrics;
mod tag_fields;

pub use cover::{
    cover_thumb_path, extract_cover_thumbnail, make_thumbnail_jpeg, read_attached_pic,
};
pub use editor::{read_tags, write_tags, TagWriteRequest};
pub use lyrics::{find_all_external_lyrics, ExternalLyric};

/// 音频元数据（包含封面路径和歌词）
#[derive(Clone, Default)]
pub struct AudioMetadata {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    /// 注释/副标题
    pub comment: Option<String>,
    pub duration_secs: f64,
    /// 播放采样率（重采样后，用于音频输出）
    pub sample_rate: u32,
    /// 音源原始声道数
    pub channels: u16,
    /// 原始采样率（解码前，用于前端显示）
    pub original_sample_rate: u32,
    /// 位深（bits per sample）
    pub bits_per_sample: u32,
    /// 比特率（bps）
    pub bit_rate: i64,
    /// 编码格式名称（如 "flac", "mp3", "aac"）
    pub codec: String,
    /// 内嵌歌词
    pub embedded_lyric: Option<String>,
    /// 同目录所有歌词文件
    pub external_lyrics: Vec<ExternalLyric>,
    /// 封面缩略图缓存路径（用于前端日常显示）
    pub cover: Option<String>,
    /// 原始封面数据（load 时一次性提取，供 SMTC 等使用，避免重复打开文件）
    pub cover_raw: Option<Vec<u8>>,
}

/// 音频流基本参数（scanner 和 decoder 共用）
pub struct StreamInfo {
    pub bit_rate: i64,
    pub sample_rate: u32,
    pub bits_per_sample: u32,
    pub channels: u32,
}

/// 容器级别的 tag 信息
pub struct Tags {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub track: Option<u16>,
    pub comment: Option<String>,
}

/// 把 ffmpeg_audio 的 SourceAudioInfo 转成内部 StreamInfo
pub fn extract_stream_info(info: &SourceAudioInfo) -> StreamInfo {
    StreamInfo {
        bit_rate: info.bit_rate,
        sample_rate: info.sample_rate.max(0) as u32,
        bits_per_sample: info.bits_per_sample.max(0) as u32,
        channels: info.channels.max(0) as u32,
    }
}

/// 从容器 metadata 提取常见 tag
pub fn extract_tags(dict: &HashMap<String, String>) -> Tags {
    let title = dict_get(dict, "title").map(ToString::to_string);
    let artist = dict_get(dict, "artist")
        .or_else(|| dict_get(dict, "album_artist"))
        .map(ToString::to_string);
    let album = dict_get(dict, "album").map(ToString::to_string);
    let track = dict_get(dict, "track").and_then(|s| s.parse().ok());
    let comment = dict_get(dict, "comment").map(ToString::to_string);
    Tags {
        title,
        artist,
        album,
        track,
        comment,
    }
}

/// 提取 tag，当 FFmpeg 返回的文本含替换字符（U+FFFD）时用 lofty 回退读取。
///
/// FFmpeg 的 AVDictionary 对 ID3v1 等非 UTF-8 标签不做编码转换，
/// `ffmpeg_audio` 用 `to_string_lossy()` 读取后非 UTF-8 字节被替换为 U+FFFD，
/// 造成不可逆的信息丢失。lofty 对 ID3v2 的编码声明有正确处理，作为回退可靠。
///
/// @param dict - FFmpeg 返回的 metadata 字典
/// @param path - 音频文件路径，用于 lofty 回退
pub fn extract_tags_with_fallback(dict: &HashMap<String, String>, path: &str) -> Tags {
    let tags = extract_tags(dict);
    if tags_needs_fallback(&tags) {
        if let Ok(lofty_tags) = editor::read_tags(path) {
            return Tags {
                title: pick_clean(tags.title, lofty_tags.title),
                artist: pick_clean(tags.artist, lofty_tags.artist),
                album: pick_clean(tags.album, lofty_tags.album),
                track: lofty_tags.track_number.and_then(|t| u16::try_from(t).ok()).or(tags.track),
                comment: tags.comment,
            };
        }
    }
    tags
}

/// 判断 FFmpeg 返回的标签是否含替换字符，需要 lofty 回退
fn tags_needs_fallback(tags: &Tags) -> bool {
    let has_replacement = |s: &Option<String>| s.as_ref().is_some_and(|v| v.contains('\u{FFFD}'));
    has_replacement(&tags.title) || has_replacement(&tags.artist) || has_replacement(&tags.album)
}

/// 优先选取不含替换字符的值；两者都干净时保留 FFmpeg 的原始值
fn pick_clean(ffmpeg: Option<String>, lofty: Option<String>) -> Option<String> {
    let ffmpeg_clean = ffmpeg.as_ref().is_none_or(|v| !v.contains('\u{FFFD}'));
    if ffmpeg_clean {
        return ffmpeg;
    }
    lofty
}

/// 提取标签和内嵌歌词，当 FFmpeg 返回的文本含替换字符时用 lofty 回退读取。
/// 合并 tag 和歌词的回退逻辑，确保 lofty 只打开文件一次。
///
/// @param dict - FFmpeg 返回的 metadata 字典
/// @param path - 音频文件路径，用于 lofty 回退
/// @returns (Tags, Option<String>) - 标签和内嵌歌词
pub fn extract_tags_and_lyric_with_fallback(
    dict: &HashMap<String, String>,
    path: &str,
) -> (Tags, Option<String>) {
    let tags = extract_tags(dict);
    let lyric = lyrics::extract_embedded_lyric(dict);

    let tags_need_fallback = tags_needs_fallback(&tags);
    let lyric_need_fallback = lyric.as_ref().is_some_and(|v| v.contains('\u{FFFD}'));

    if !tags_need_fallback && !lyric_need_fallback {
        return (tags, lyric);
    }

    // 只打开 lofty 一次，同时回退 tag 和歌词
    if let Ok(lofty_tags) = editor::read_tags(path) {
        let resolved_tags = if tags_need_fallback {
            Tags {
                title: pick_clean(tags.title, lofty_tags.title),
                artist: pick_clean(tags.artist, lofty_tags.artist),
                album: pick_clean(tags.album, lofty_tags.album),
                track: lofty_tags.track_number.and_then(|t| u16::try_from(t).ok()).or(tags.track),
                comment: tags.comment,
            }
        } else {
            tags
        };
        let resolved_lyric = if lyric_need_fallback {
            lofty_tags.lyrics.or(lyric)
        } else {
            lyric
        };
        return (resolved_tags, resolved_lyric);
    }

    (tags, lyric)
}

/// 大小写不敏感查找：原 ffmpeg-next 的 Dictionary::get 默认 case-insensitive，
/// 而 ffmpeg_audio 把 dict 转成普通 HashMap 后丢了这个语义，这里补回来
fn dict_get<'a>(dict: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    let target = tag_fields::normalize_tag_key(key);
    dict.iter()
        .find(|(k, _)| tag_fields::normalize_tag_key(k) == target)
        .map(|(_, v)| v.as_str())
}

/// 从容器 metadata 提取 ReplayGain / R128 增益值（dB）
///
/// 按优先级尝试：R128_TRACK_GAIN → replaygain_track_gain → album 版本
pub fn extract_replay_gain(dict: &HashMap<String, String>) -> Option<f32> {
    // EBU R128：值为 1/256 dB 单位的整数
    if let Some(val) =
        dict_get(dict, "R128_TRACK_GAIN").or_else(|| dict_get(dict, "R128_ALBUM_GAIN"))
    {
        if let Ok(raw) = val.trim().parse::<f32>() {
            return Some(raw / 256.0);
        }
    }

    // ReplayGain：格式如 "-6.50 dB"
    if let Some(val) =
        dict_get(dict, "replaygain_track_gain").or_else(|| dict_get(dict, "replaygain_album_gain"))
    {
        let cleaned = val.trim().trim_end_matches(" dB").trim_end_matches("dB");
        if let Ok(db) = cleaned.parse::<f32>() {
            return Some(db);
        }
    }

    None
}

/// 将 dB 增益转换为线性增益因子
pub fn db_to_linear(db: f32) -> f32 {
    10.0_f32.powf(db / 20.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn common_tags_are_matched_case_insensitively() {
        let dict = HashMap::from([
            ("TITLE".to_string(), "Track".to_string()),
            ("Album_Artist".to_string(), "Artist".to_string()),
            ("TRACK".to_string(), "7".to_string()),
        ]);

        let tags = extract_tags(&dict);
        assert_eq!(tags.title.as_deref(), Some("Track"));
        assert_eq!(tags.artist.as_deref(), Some("Artist"));
        assert_eq!(tags.track, Some(7));
    }

    #[test]
    fn r128_track_gain_has_priority_and_uses_fixed_point_units() {
        let dict = HashMap::from([
            ("R128_TRACK_GAIN".to_string(), "-1536".to_string()),
            ("replaygain_track_gain".to_string(), "-3.00 dB".to_string()),
        ]);

        assert_eq!(extract_replay_gain(&dict), Some(-6.0));
    }

    #[test]
    fn decibels_are_converted_to_linear_gain() {
        assert!((db_to_linear(-6.0) - 0.501_187_2).abs() < 0.000_001);
    }
}
