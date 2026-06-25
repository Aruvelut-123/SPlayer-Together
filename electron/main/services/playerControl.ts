/**
 * 播放控制聚合入口
 *
 * 把"外部来源"（系统媒体、HTTP/WS 外部 API、控制类插件）发起的播放控制
 * 收敛到一处：引擎直控 + 必要时通知渲染层补记账。
 */

import { getPlayer } from "@main/services/engine";
import { sendToMain } from "@main/utils/broadcast";

/**
 * 跳转（毫秒）
 * 先通知渲染层补 seek 记账（使歌词引擎按跳转处理、屏蔽旧 position），再跳引擎。
 * @param positionMs - 目标位置（毫秒）
 */
const seek = (positionMs: number): void => {
  sendToMain("player:event", { type: "seek", data: { position: positionMs } });
  void getPlayer()
    .seek(positionMs / 1000)
    .catch(() => {});
};

export const playerControl = {
  play: (): void =>
    void getPlayer()
      .play()
      .catch(() => {}),
  pause: (): void => getPlayer().pause(),
  stop: (): void => getPlayer().stop(),
  next: (): void => sendToMain("player:event", { type: "next" }),
  prev: (): void => sendToMain("player:event", { type: "prev" }),
  seek,
  setVolume: (volume: number): void => getPlayer().setVolume(volume),
};
