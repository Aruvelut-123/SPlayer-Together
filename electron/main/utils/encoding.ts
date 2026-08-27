import { readFile } from "node:fs/promises";

// 复用 TextDecoder 实例，避免每次调用都分配新对象
const utf8Decoder = new TextDecoder("utf-8");
const utf16leDecoder = new TextDecoder("utf-16le");
const utf16beDecoder = new TextDecoder("utf-16be");
const gb18030Decoder = new TextDecoder("gb18030");

/**
 * 检测 Buffer 编码并解码为字符串
 *
 * 检测顺序：
 * 1. BOM 标记（UTF-8 BOM / UTF-16 LE/BE BOM）
 * 2. 严格 UTF-8 验证（全量合法则判定为 UTF-8）
 * 3. 回退 gb18030（向下兼容 GBK / GB2312，覆盖中文 Windows 环境常见编码）
 *
 * Node.js 内置 TextDecoder 原生支持 gb18030，无需额外依赖
 *
 * @param buf - 文件原始字节
 * @returns 解码后的字符串
 */
export const decodeAuto = (buf: Buffer): string => {
  if (buf.length === 0) return "";

  // BOM 检测
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return utf8Decoder.decode(buf.subarray(3));
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return utf16leDecoder.decode(buf.subarray(2));
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return utf16beDecoder.decode(buf.subarray(2));
  }

  // 严格 UTF-8 验证：任何一个非法字节即判定非 UTF-8
  if (isUtf8(buf)) {
    return utf8Decoder.decode(buf);
  }

  // 回退 gb18030（中文 Windows 最常见的非 UTF-8 编码）
  return gb18030Decoder.decode(buf);
};

/**
 * 读取文件并自动检测编码解码为字符串
 * @param filePath - 文件路径
 * @returns 解码后的字符串
 */
export const readFileAutoEncoding = async (filePath: string): Promise<string> => {
  const buf = await readFile(filePath);
  return decodeAuto(buf);
};

/**
 * 严格 UTF-8 校验：逐字节检查编码合法性
 * UTF-8 编码规则：
 * - 0x00-0x7F：单字节
 * - 0xC2-0xDF：双字节起始（续字节 0x80-0xBF）
 * - 0xE0-0xEF：三字节起始
 * - 0xF0-0xF4：四字节起始
 * 任何违反上述规则的字节序列都意味着不是 UTF-8
 *
 * @param buf - 原始字节
 * @returns 是否为合法 UTF-8
 */
const isUtf8 = (buf: Buffer): boolean => {
  let i = 0;
  const len = buf.length;
  while (i < len) {
    const byte = buf[i];
    // ASCII 范围
    if (byte <= 0x7f) {
      i++;
      continue;
    }
    // 多字节序列
    let expectedContinuation: number;
    if ((byte & 0xe0) === 0xc0) {
      // 两字节：0xC2-0xDF（0xC0/C1 是过长编码，非法）
      if (byte < 0xc2) return false;
      expectedContinuation = 1;
    } else if ((byte & 0xf0) === 0xe0) {
      expectedContinuation = 2;
      // 三字节首字节为 0xE0 时，续字节需 >= 0xA0（排除过长编码）
      const next = i + 1 < len ? buf[i + 1] : 0;
      if (byte === 0xe0 && (next & 0xe0) !== 0xa0) return false;
      // 三字节首字节为 0xED 时，续字节需 <= 0x9F（排除代理区 U+D800-U+DFFF）
      if (byte === 0xed && (next & 0xe0) === 0xa0) return false;
    } else if ((byte & 0xf8) === 0xf0) {
      expectedContinuation = 3;
      // 四字节首字节为 0xF0 时，续字节需 >= 0x90（排除过长编码）
      const next = i + 1 < len ? buf[i + 1] : 0;
      if (byte === 0xf0 && (next & 0xc0) !== 0x90) return false;
      // 四字节首字节为 0xF4 时，续字节需 <= 0x8F（限制 Unicode 上限 U+10FFFF）
      if (byte === 0xf4 && (next & 0xf0) !== 0x80) return false;
      // 超出 0xF4 即超出 Unicode 范围
      if (byte > 0xf4) return false;
    } else {
      // 非法首字节（0x80-0xBF 是孤立的续字节，0xC0/C1 是过长编码，0xF5-0xFF 超出范围）
      return false;
    }
    // 检查续字节
    for (let j = 1; j <= expectedContinuation; j++) {
      if (i + j >= len) return false;
      if ((buf[i + j] & 0xc0) !== 0x80) return false;
    }
    i += 1 + expectedContinuation;
  }
  return true;
};
