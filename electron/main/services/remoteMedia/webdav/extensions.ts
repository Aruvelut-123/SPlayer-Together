/** WebDAV 媒体扫描接受的音频扩展名 */
const WEBDAV_AUDIO_EXTENSIONS = new Set([
  "mp3",
  "flac",
  "wav",
  "m4a",
  "aac",
  "ogg",
  "opus",
  "wma",
  "ape",
  "aiff",
]);

/**
 * 判断 WebDAV 文件是否进入媒体扫描
 * @param filename - 不区分大小写的文件名或相对路径
 * @returns 是否具有 WebDAV 扫描支持的扩展名
 */
export const isWebDavAudioFilename = (filename: string): boolean => {
  const extension = filename.split(".").at(-1)?.toLocaleLowerCase();
  return Boolean(extension && WEBDAV_AUDIO_EXTENSIONS.has(extension));
};
