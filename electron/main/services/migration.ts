/**
 * SPlayer Next 数据迁移：检测上游设置文件并导入
 * SPlayer Next 的数据根目录为 ``{userData}/app-data``，
 * 迁移只读取 settings.json，合并到当前配置（不覆盖数据库）
 */

import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { store } from "@main/store";
import { systemLog } from "@main/utils/logger";

/** 可能的上游 App userData 目录名（按优先级尝试） */
const UPSTREAM_NAMES = ["splayer-next", "Splayer-Next", "SPlayer-Next"];

/** 从当前 userData 的父目录推算上游 userData 候选路径 */
const upstreamConfigPaths = (): string[] => {
  const parent = path.dirname(app.getPath("userData"));
  return UPSTREAM_NAMES.map((name) => path.join(parent, name, "app-data", "config", "settings.json"));
};

/** 检查是否存在可迁移的 SPlayer Next 设置 */
export const checkSPlayerNextConfig = (): { exists: boolean; path: string | null } => {
  for (const p of upstreamConfigPaths()) {
    if (fs.existsSync(p)) {
      return { exists: true, path: p };
    }
  }
  return { exists: false, path: null };
};

/** 从 SPlayer Next 迁移设置 */
export const migrateSPlayerNextConfig = (): { ok: boolean; error?: string } => {
  const { exists, path: srcPath } = checkSPlayerNextConfig();
  if (!exists || !srcPath) {
    return { ok: false, error: "未找到 SPlayer Next 设置文件" };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(srcPath, "utf-8"));
    if (typeof raw !== "object" || raw === null) {
      return { ok: false, error: "设置文件格式无效" };
    }
    store.replaceAll(raw);
    systemLog.info("已从 %s 迁移设置", srcPath);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    systemLog.error("迁移失败：%s", message);
    return { ok: false, error: `迁移失败: ${message}` };
  }
};