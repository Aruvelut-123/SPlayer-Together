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
  /** 贡献来源 */
  source: "fork" | "upstream";
}

/* 仓库标识（本 Fork 仓库 + 上游原仓库一起查） */
const repoSlug = "Aruvelut-123/SPlayer-Together";
const upstreamSlug = "SPlayer-Dev/SPlayer-Next";

/** 作者账号的 GitHub 用户名 → 展示名（重命名为用户对外使用的名字） */
const AUTHOR_LOGIN = "Aruvelut-123";
const AUTHOR_DISPLAY = "Baymaxawa";
/** 固定贡献者顺序：原作者第一，Fork 作者第二，其余按 GitHub 返回顺序 */
const CONTRIBUTOR_PRIORITY = [AUTHOR_DISPLAY, "imsyy"];

/**
 * 获取仓库贡献者列表（合并本仓库与上游仓库的贡献者）
 * @returns 贡献者数组
 */
export const getContributors = async (): Promise<Contributor[]> => {
  const repositories: Array<{ slug: string; source: Contributor["source"] }> = [
    { slug: repoSlug, source: "fork" },
    { slug: upstreamSlug, source: "upstream" },
  ];
  const contributors = new Map<string, Contributor>();
  for (const { slug, source } of repositories) {
    try {
      const res = await fetch(
        `https://api.github.com/repos/${slug}/contributors?per_page=100&anon=true`,
      );
      if (!res.ok) continue;
      const data = await res.json();
      if (!Array.isArray(data)) continue;
      for (const item of data) {
        if (item.type === "Bot" || item.login === "type-bot") continue;
        const rawLogin = item.login ?? item.name ?? "anonymous";
        const login = rawLogin === AUTHOR_LOGIN ? AUTHOR_DISPLAY : rawLogin;
        const contributor: Contributor = {
          login,
          htmlUrl: item.html_url ?? "",
          avatar: item.avatar_url ?? "",
          source,
        };
        const existing = contributors.get(login);
        if (!existing || (source === "fork" && existing.source === "upstream")) {
          contributors.set(login, contributor);
        }
      }
    } catch {
      // 单个仓库失败不影响另一个
    }
  }
  const priority = new Map(CONTRIBUTOR_PRIORITY.map((login, index) => [login, index]));
  return [...contributors.values()].sort(
    (a, b) =>
      (priority.get(a.login) ?? CONTRIBUTOR_PRIORITY.length) -
      (priority.get(b.login) ?? CONTRIBUTOR_PRIORITY.length),
  );
};
