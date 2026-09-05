/** 按版本分组的更新日志段落 */
interface VersionSection {
  version: string;
  body: string;
}

/** 解析多版本 Markdown 更新日志为段落列表 */
const parseMultiVersion = (raw: string): VersionSection[] => {
  const sections = raw.split(/(?=^# )/m);
  const result: VersionSection[] = [];
  for (const section of sections) {
    const match = section.match(/^# (.+)$/m);
    if (match) result.push({ version: match[1].trim(), body: section.trim() });
  }
  return result;
};

/** 简单 semver 比较：a > b 返回正数，a === b 返回 0 */
const compareVersions = (a: string, b: string): number => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
};

/**
 * 从多版本更新日志中提取指定版本的段落
 * @param raw - 多版本 Markdown 字符串（向后兼容：无版本标题时作为整体返回）
 * @param version - 目标版本号
 * @returns 对应版本的 Markdown 内容；无匹配时返回空字符串
 */
export const getChangelog = (raw: string, version: string): string => {
  const sections = parseMultiVersion(raw);
  // 向后兼容：无版本标题 → 整个当作文本返回
  if (sections.length === 0) return raw.trim();
  return sections.find((item) => item.version === version)?.body ?? "";
};

/**
 * 从多版本更新日志中聚合从 fromVersion 之后（不含）到 toVersion（含）的段落
 * @param raw - 多版本 Markdown 字符串
 * @param fromVersion - 用户当前版本（不含）
 * @param toVersion - 最新版本（含）；缺省时聚合所有更新的版本
 * @returns 各版本 Markdown 内容按版本顺序拼接
 */
export const getChangelogRange = (raw: string, fromVersion: string, toVersion?: string): string => {
  const sections = parseMultiVersion(raw);
  // 向后兼容：无版本标题 → 整个当作文本范围返回
  if (sections.length === 0) return raw.trim();
  return sections
    .filter((item) => compareVersions(item.version, fromVersion) > 0)
    .filter((item) => !toVersion || compareVersions(item.version, toVersion) <= 0)
    .map((item) => item.body)
    .join("\n\n");
};
