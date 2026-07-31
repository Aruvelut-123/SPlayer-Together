import { listWebDavDirectory } from "./client";
import { isWebDavAudioFilename } from "./extensions";
import { createWebDavRootUrl } from "./paths";
import type { WebDavResource } from "./parser";
import type { WebDavRuntimeConfig } from "./types";

const DIRECTORY_CONCURRENCY = 4;

export interface ScannedWebDavTrack {
  relativePath: string;
  title: string;
  contentLength?: number;
  lastModified?: number;
  etag?: string;
}

interface DirectoryTask {
  url: URL;
  depth: number;
}

/**
 * 从相对路径生成首屏可用的文件名歌曲
 * @param resource - 已校验的 WebDAV 文件
 * @returns 不依赖播放器模型的远程文件记录
 */
const toFilenameTrack = (resource: WebDavResource): ScannedWebDavTrack => {
  const filename = resource.relativePath.split("/").at(-1) ?? resource.relativePath;
  const title = filename.replace(/\.[^.]+$/, "") || filename;
  const mtime = resource.lastModified ? Date.parse(resource.lastModified) : Number.NaN;
  return {
    relativePath: resource.relativePath,
    title,
    contentLength: resource.contentLength,
    lastModified: Number.isFinite(mtime) ? mtime : undefined,
    etag: resource.etag,
  };
};

/**
 * 以有限深度和固定并发扫描 WebDAV 音频目录
 * @param config - WebDAV 来源配置
 * @param isCancelled - 是否已经取消当前同步
 * @returns 完整文件名歌曲快照
 */
export const scanWebDav = async (
  config: WebDavRuntimeConfig,
  isCancelled: () => boolean,
): Promise<ScannedWebDavTrack[]> => {
  const scanDepth = config.scanDepth ?? 0;
  if (!Number.isInteger(scanDepth) || scanDepth < 0) throw new Error("WebDAV 扫描深度无效");

  const rootUrl = createWebDavRootUrl(config.url, config.rootPath ?? "/");
  const queue: DirectoryTask[] = [{ url: rootUrl, depth: 0 }];
  const visitedDirectories = new Set<string>();
  const tracks = new Map<string, ScannedWebDavTrack>();

  while (queue.length > 0) {
    if (isCancelled()) return [];
    const batch = queue.splice(0, DIRECTORY_CONCURRENCY).filter((task) => {
      if (visitedDirectories.has(task.url.href)) return false;
      visitedDirectories.add(task.url.href);
      return true;
    });
    const results = await Promise.all(
      batch.map(async (task) => ({
        task,
        resources: await listWebDavDirectory(config, task.url, rootUrl),
      })),
    );
    for (const { task, resources } of results) {
      for (const resource of resources) {
        if (resource.isCollection) {
          if (task.depth < scanDepth) {
            queue.push({ url: new URL(resource.href), depth: task.depth + 1 });
          }
        } else if (isWebDavAudioFilename(resource.relativePath)) {
          tracks.set(resource.relativePath, toFilenameTrack(resource));
        }
      }
    }
  }
  return [...tracks.values()];
};
