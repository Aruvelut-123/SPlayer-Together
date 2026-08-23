/**
 * GitHub 仓库相关接口
 */

/** 贡献者信息 */
export interface Contributor {
  /** 用户名 */
  login: string;
  /** 主页地址 */
  htmlUrl: string;
  /** 头像地址 */
  avatar: string;
}

/* 仓库标识（本 Fork 仓库 + 上游原仓库一起查） */
const repoSlug = "Aruvelut-123/SPlayer-Together";
const upstremSlug = "SPlayer-Dev/SPlayer-Next";

/**
 * 获取仓库贡献者列表（合并本仓库与上游仓库的贡献者）
 * @returns 贡献者数组
 */
export const getContributors = async (): Promise<Contributor[]> => {
  const slugs = [repoSlug, upstremSlug];
  const seen = new Set<string>();
  const results: Contributor[] = [];
  for (const slug of slugs) {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${slug}/contributors?per_page=100&anon=true`,
      );
      if (!res.ok) continue;
      const data = await res.json();
      if (!Array.isArray(data)) continue;
      for (const item of data) {
        if (item.type === "Bot" || item.login === "type-bot") continue;
        const login = item.login ?? item.name ?? "anonymous";
        if (seen.has(login)) continue;
        seen.add(login);
        results.push({
          login,
          htmlUrl: item.html_url ?? "",
          avatar: item.avatar_url ?? "",
        });
      }
    } catch {
      // 单个仓库失败不影响另一个
    }
  }
  return results;
};
