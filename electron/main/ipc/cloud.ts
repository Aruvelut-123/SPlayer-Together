import { ipcMain, dialog } from "electron";
import path from "node:path";
import { stat } from "node:fs/promises";
import { uploadCloudSong } from "@main/services/cloudUpload";
import { cloudLog } from "@main/utils/logger";
import { AUDIO_EXTENSIONS } from "@shared/types/cloudUpload";
import type { CloudUploadProgress, CloudUploadResult, PickedSong } from "@shared/types/cloudUpload";

/** 进度事件节流间隔(ms) */
const PROGRESS_THROTTLE_MS = 200;

/** 注册云盘上传相关 IPC */
export const registerCloudIpc = (): void => {
  // 弹出文件选择器,返回选中歌曲的路径/名称/大小
  ipcMain.handle("cloud:pickSongs", async (): Promise<PickedSong[]> => {
    const result = await dialog.showOpenDialog({
      title: "选择要上传的歌曲",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "音频文件", extensions: AUDIO_EXTENSIONS }],
    });
    if (result.canceled) return [];
    const songs: PickedSong[] = [];
    for (const filePath of result.filePaths) {
      try {
        const info = await stat(filePath);
        songs.push({ path: filePath, name: path.basename(filePath), size: info.size });
      } catch (err) {
        cloudLog.warn(`读取文件信息失败: ${filePath}`, err);
      }
    }
    return songs;
  });

  // 上传单首,过程中推送进度事件,返回最终结果
  ipcMain.handle(
    "cloud:uploadSong",
    async (event, filePath: string, uploadId: string): Promise<CloudUploadResult> => {
      let lastEmit = 0;
      try {
        const res = await uploadCloudSong(filePath, ({ stage, loaded, total }) => {
          const now = Date.now();
          // uploading 中间帧节流;首帧(loaded 为 0)与完成帧(loaded≥total)始终放行
          if (
            stage === "uploading" &&
            loaded > 0 &&
            loaded < total &&
            now - lastEmit < PROGRESS_THROTTLE_MS
          ) {
            return;
          }
          lastEmit = now;
          const payload: CloudUploadProgress = { uploadId, stage, loaded, total };
          if (!event.sender.isDestroyed()) event.sender.send("cloud:upload-progress", payload);
        });
        cloudLog.info(`上传完成: ${filePath} (instant=${res.instant})`);
        return res;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const matched = message.match(/^netease (\d+)/);
        cloudLog.error(`上传失败: ${filePath}`, err);
        return {
          success: false,
          instant: false,
          errorCode: matched ? Number(matched[1]) : undefined,
        };
      }
    },
  );
};
