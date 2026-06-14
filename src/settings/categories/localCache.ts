import type { SettingCategory } from "@/types/settings-schema";
import { useSettingsStore } from "@/stores/settings";
import FileCacheManager from "@/components/settings/custom/FileCacheManager.vue";
import DbCacheManager from "@/components/settings/custom/DbCacheManager.vue";
import DownloadDirConfig from "@/components/settings/custom/DownloadDirConfig.vue";
import IconLucideHardDrive from "~icons/lucide/hard-drive";

const localCacheCategory: SettingCategory = {
  id: "localCache",
  icon: IconLucideHardDrive,
  sections: [
    {
      id: "downloadLocation",
      items: [
        {
          key: "downloadDir",
          type: "custom",
          component: DownloadDirConfig,
          fullWidth: true,
          keywords: ["downloadDir.label"],
        },
      ],
    },
    {
      id: "downloadGeneral",
      items: [
        {
          key: "downloadQuality",
          type: "select",
          binding: { store: "settings", path: "system.download.quality" },
          options: [
            { value: "hi-res", label: "Hi-Res" },
            { value: "lossless", label: "Lossless" },
            { value: "hq", label: "HQ" },
            { value: "sq", label: "SQ" },
            { value: "lq", label: "LQ" },
          ],
          defaultValue: "lossless",
        },
        {
          key: "downloadUsePlayback",
          type: "switch",
          binding: { store: "settings", path: "system.download.usePlaybackForDownload" },
          defaultValue: false,
        },
        {
          key: "downloadFileTemplate",
          type: "select",
          binding: { store: "settings", path: "system.download.fileTemplate" },
          options: [
            { value: "{artist} - {title}", label: "{artist} - {title}" },
            { value: "{title} - {artist}", label: "{title} - {artist}" },
            { value: "{title}", label: "{title}" },
            { value: "{album}/{artist} - {title}", label: "{album}/{artist} - {title}" },
          ],
          defaultValue: "{artist} - {title}",
        },
        {
          key: "downloadOverwrite",
          type: "select",
          binding: { store: "settings", path: "system.download.overwritePolicy" },
          options: [
            { value: "rename", labelKey: "settings.downloadOverwrite.rename" },
            { value: "overwrite", labelKey: "settings.downloadOverwrite.overwrite" },
            { value: "skip", labelKey: "settings.downloadOverwrite.skip" },
          ],
          defaultValue: "rename",
        },
      ],
    },
    {
      id: "downloadTags",
      items: [
        {
          key: "downloadEmbedCover",
          type: "switch",
          binding: { store: "settings", path: "system.download.embedCover" },
          defaultValue: true,
        },
        {
          key: "downloadEmbedMeta",
          type: "switch",
          binding: { store: "settings", path: "system.download.embedMeta" },
          defaultValue: true,
        },
        {
          key: "downloadEmbedLyric",
          type: "switch",
          binding: { store: "settings", path: "system.download.embedLyric" },
          defaultValue: true,
        },
        {
          key: "downloadWriteLrc",
          type: "switch",
          binding: { store: "settings", path: "system.download.writeLrc" },
          defaultValue: true,
        },
      ],
    },
    {
      id: "songCache",
      items: [
        {
          key: "enableSongCache",
          type: "switch",
          binding: { store: "settings", path: "system.cache.songCache.enabled" },
          defaultValue: false,
          children: [
            {
              key: "songCacheSizeLimit",
              type: "slider",
              binding: { store: "settings", path: "system.cache.songCache.sizeLimitGb" },
              min: 0,
              max: 50,
              step: 1,
              marks: {
                0: "∞",
                10: "10G",
                20: "20G",
                50: "50G",
              },
              defaultValue: 10,
            },
          ],
          childrenCondition: () => useSettingsStore().system.cache?.songCache?.enabled === true,
        },
      ],
    },
    {
      id: "cache",
      items: [
        {
          key: "fileCacheManager",
          type: "custom",
          component: FileCacheManager,
          fullWidth: true,
          keywords: ["cacheDir.label", "fileClearAll.label"],
        },
      ],
    },
    {
      id: "database",
      items: [
        {
          key: "dbCacheManager",
          type: "custom",
          component: DbCacheManager,
          fullWidth: true,
          keywords: ["dbClearAll.label"],
        },
      ],
    },
  ],
};

export default localCacheCategory;
