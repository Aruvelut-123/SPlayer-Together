import i18n from "@/i18n";

/**
 * 应用授权（License）
 *
 * 应用按机器 ID 生成唯一密钥，用户把密钥交给管理员加入服务器白名单后，
 * 软件携带密钥询问服务器 ``POST /api/auth`` 校验。
 * 无法连接服务器时不锁定使用，只提示用户；连续离线超过 1 小时则自动关闭应用。
 */

import { toast } from "@/composables/useToast";

/** 授权复核间隔（毫秒） */
export const LICENSE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
/** 连续无法连接服务器的宽限期（毫秒），超过后自动退出 */
export const OFFLINE_GRACE_MS = 60 * 60 * 1000;

/** 授权 / 更新 / 中继服务器地址（固定） */
export const RELAY_SERVER_URL = "http://47.122.127.107:8000";

export const useLicenseStore = defineStore(
  "license",
  () => {
    /** 中继服务器地址（固定不可更改） */
    const serverUrl = ref(RELAY_SERVER_URL);
    /** 机器授权密钥（按机器 ID 生成） */
    const machineKey = ref("");
    /** 是否已通过校验 */
    const authorized = ref(false);
    /** 校验中 */
    const checking = ref(false);
    /** 最近一次校验错误 */
    const lastError = ref("");
    /** 最近一次成功校验时间戳 */
    const lastCheckedAt = ref(0);
    /** 连续离线开始时间戳（null 表示在线或未开始计时） */
    const offlineSince = ref<number | null>(null);

    /** 服务器地址去尾斜杠 */
    const baseUrl = computed(() => serverUrl.value.replace(/\/+$/, ""));

    /** 从主进程读取机器授权密钥 */
    const loadMachineKey = async (): Promise<string> => {
      if (!machineKey.value) {
        machineKey.value = await window.api.system.getMachineKey();
      }
      return machineKey.value;
    };

    /** 进入离线宽限期：首次提示，超过 1 小时自动关闭应用 */
    const startOfflineGrace = (): void => {
      if (offlineSince.value === null) {
        offlineSince.value = Date.now();
        toast.warning(i18n.global.t("license.offlineNotice"), { duration: 5_000 });
      }
      if (Date.now() - offlineSince.value >= OFFLINE_GRACE_MS) {
        window.api.window.quit();
      }
    };

    /** 跳过授权继续使用（宽限期开始计时） */
    const continueWithoutAuth = (): void => {
      authorized.value = true;
      lastError.value = "";
      if (offlineSince.value === null) {
        offlineSince.value = Date.now();
        toast.warning(i18n.global.t("license.offlineNotice"), { duration: 5_000 });
      }
    };

    /** 携带密钥询问服务器；失败不锁定已授权用户，仅提示并计时 */
    const verify = async (): Promise<boolean> => {
      if (!machineKey.value) {
        await loadMachineKey();
      }
      checking.value = true;
      lastError.value = "";
      try {
        const res = await fetch(`${baseUrl.value}/api/auth`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key: machineKey.value }),
        });
        if (res.ok) {
          lastCheckedAt.value = Date.now();
          authorized.value = true;
          offlineSince.value = null;
          return true;
        }
        if (authorized.value) {
          startOfflineGrace();
        } else {
          lastError.value = i18n.global.t("license.invalidKey");
        }
        return false;
      } catch {
        if (authorized.value) {
          startOfflineGrace();
        } else {
          lastError.value = i18n.global.t("license.networkError");
        }
        return false;
      } finally {
        checking.value = false;
      }
    };

    return {
      serverUrl,
      machineKey,
      authorized,
      checking,
      lastError,
      lastCheckedAt,
      offlineSince,
      loadMachineKey,
      verify,
      continueWithoutAuth,
    };
  },
  {
    persist: {
      storage: localStorage,
      pick: [],
    },
  },
);
