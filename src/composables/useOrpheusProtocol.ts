import { handleOrpheus } from "@/services/orpheus";

/**
 * 主窗口接入 orpheus 协议唤起
 */
export const useOrpheusProtocol = (): void => {
  let unsubscribe: (() => void) | null = null;
  onMounted(async () => {
    // 先注册监听再拉 pending，避免两步之间漏掉实时事件
    unsubscribe = window.api.system.onProtocolUrl(handleOrpheus);
    const pending = await window.api.system.consumePendingProtocolUrl();
    if (pending) await handleOrpheus(pending);
  });
  onBeforeUnmount(() => unsubscribe?.());
};
