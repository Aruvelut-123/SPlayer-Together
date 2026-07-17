import type { Component } from "vue";
import IconLucideHome from "~icons/lucide/home";
import IconLucideMusic from "~icons/lucide/music";
import IconLucideUser from "~icons/lucide/user";
import IconLucideDisc3 from "~icons/lucide/disc-3";
import IconLucideFolder from "~icons/lucide/folder";
import IconLucideServer from "~icons/lucide/server";
import IconMaterialSymbolsFavoriteOutline from "~icons/material-symbols/favorite-outline-rounded";
import IconLucideStar from "~icons/lucide/star";
import IconLucideHistory from "~icons/lucide/history";
import IconLucideDownload from "~icons/lucide/download";
import IconLucideCloud from "~icons/lucide/cloud";

/** 侧边栏固定导航项元数据 */
export interface SidebarNavEntry {
  /** 路由路径，同时作为菜单 key */
  key: string;
  /** i18n key */
  labelKey: string;
  icon: Component;
  /** 是否允许隐藏 */
  hideable: boolean;
}

const SIDEBAR_NAV_ENTRIES: SidebarNavEntry[] = [
  { key: "/", labelKey: "nav.home", icon: IconLucideHome, hideable: false },
  { key: "/library", labelKey: "nav.library", icon: IconLucideMusic, hideable: true },
  { key: "/artists/local", labelKey: "artist.label", icon: IconLucideUser, hideable: true },
  { key: "/albums/local", labelKey: "album.label", icon: IconLucideDisc3, hideable: true },
  { key: "/folders", labelKey: "folder.label", icon: IconLucideFolder, hideable: true },
  {
    key: "/liked",
    labelKey: "nav.liked",
    icon: IconMaterialSymbolsFavoriteOutline,
    hideable: true,
  },
  { key: "/favorites", labelKey: "nav.favorites", icon: IconLucideStar, hideable: true },
  { key: "/cloud", labelKey: "nav.cloud", icon: IconLucideCloud, hideable: true },
  { key: "/download", labelKey: "nav.download", icon: IconLucideDownload, hideable: true },
  { key: "/streaming", labelKey: "nav.streaming", icon: IconLucideServer, hideable: true },
  { key: "/history", labelKey: "nav.history", icon: IconLucideHistory, hideable: true },
];

/** key → 导航项元数据 */
export const SIDEBAR_NAV_META: Record<string, SidebarNavEntry> = Object.fromEntries(
  SIDEBAR_NAV_ENTRIES.map((entry) => [entry.key, entry]),
);

/**
 * 按存档顺序重排列表：存档中存在的项靠前（按存档顺序），
 * 其余项按自然顺序追加；空存档返回原列表
 * @param items - 自然顺序列表
 * @param order - 存档的 key 顺序
 * @returns 重排后的列表
 */
export const applySavedOrder = <T extends { key: string }>(items: T[], order: string[]): T[] => {
  if (order.length === 0) return items;
  const map = new Map(items.map((item) => [item.key, item]));
  const sorted: T[] = [];
  for (const key of order) {
    const item = map.get(key);
    if (!item) continue;
    sorted.push(item);
    map.delete(key);
  }
  for (const item of items) {
    if (map.has(item.key)) sorted.push(item);
  }
  return sorted;
};
