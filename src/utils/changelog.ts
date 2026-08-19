import changelogRaw from "../../CHANGELOG.md?raw";

type VersionSection = { version: string; body: string };

/** 解析 CHANGELOG.md 为按版本排列的段落（保持文件顺序） */
const parseChangelog = (): VersionSection[] => {
  const sections = changelogRaw.split(/(?=^# )/m);
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
 * 获取指定版本的更新日志
 * @param version - 目标版本号（如 "1.0.2"）
 * @returns 对应版本的 Markdown 内容；该版本无记录时返回空字符串
 */
export const getChangelog = (version: string): string =>
  parseChangelog().find((item) => item.version === version)?.body ?? "";

/**
 * 聚合从 fromVersion 之后（不含）到 toVersion（含）的所有版本更新日志
 * 用于更新弹窗：让用户一眼看到从自己版本升级会经历的全部变更
 * @param fromVersion - 用户当前版本（不含）
 * @param toVersion - 最新版本（含）；缺省时聚合文件中所有更新的版本
 * @returns 各版本 Markdown 内容按版本顺序拼接
 */
export const getChangelogRange = (fromVersion: string, toVersion?: string): string =>
  parseChangelog()
    .filter((item) => compareVersions(item.version, fromVersion) > 0)
    .filter((item) => !toVersion || compareVersions(item.version, toVersion) <= 0)
    .map((item) => item.body)
    .join("\n\n");