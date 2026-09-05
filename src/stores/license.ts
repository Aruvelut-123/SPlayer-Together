/**
 * 中继服务器配置：用于一起听房间通讯的自建服务器地址
 * 从设置项 ``system.relayServerUrl`` 读取，留空使用默认地址
 */
import { useSettingsStore } from "@/stores/settings";

export const RELAY_SERVER_URL = "http://47.122.127.107:8000";

export const useLicenseStore = defineStore("license", () => {
  const settings = useSettingsStore();

  /** 中继服务器地址：优先使用设置项，回退到硬编码默认值 */
  const serverUrl = computed(() => {
    const custom = settings.system.system.relayServerUrl;
    return custom?.trim() || RELAY_SERVER_URL;
  });

  /** 始终已授权（移除了设备码检查） */
  const authorized = ref(true);

  return {
    serverUrl,
    authorized,
    machineKey: ref(""),
    checking: ref(false),
    lastError: ref(""),
    lastCheckedAt: ref(0),
    offlineSince: ref<number | null>(null),
  };
});
