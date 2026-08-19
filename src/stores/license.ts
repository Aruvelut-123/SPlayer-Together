import i18n from "@/i18n";

/**
 * 应用授权（License）
 *
 * 应用按机器 ID 生成唯一密钥，用户把密钥交给管理员加入服务器白名单后，
 * 软件携带密钥询问服务器 ``POST /api/auth`` 校验，命中白名单才解锁主界面。
 * 授权成功后仍会周期性（默认 5 分钟）复核，密钥失效立即锁定。
 */

/** 授权复核间隔（毫秒） */
export const LICENSE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

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

    /** 服务器地址去尾斜杠 */
    const baseUrl = computed(() => serverUrl.value.replace(/\/+$/, ""));

    /** 从主进程读取机器授权密钥 */
    const loadMachineKey = async (): Promise<string> => {
      if (!machineKey.value) {
        machineKey.value = await window.api.system.getMachineKey();
      }
      return machineKey.value;
    };

    /** 携带密钥询问服务器，通过后解锁应用 */
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
          return true;
        }
        lastError.value = i18n.global.t("license.invalidKey");
        authorized.value = false;
        return false;
      } catch {
        lastError.value = i18n.global.t("license.networkError");
        authorized.value = false;
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
      loadMachineKey,
      verify,
    };
  },
  {
    persist: {
      storage: localStorage,
      pick: [],
    },
  },
);
