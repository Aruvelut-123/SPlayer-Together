import type { PluginInfo } from "@shared/types/plugin";

/** 插件管理 Pinia store */
export const usePluginsStore = defineStore("plugins", () => {
  const list = shallowRef<PluginInfo[]>([]);
  const loaded = ref(false);
  let unsubscribe: (() => void) | null = null;

  /** 仅 manifest.type 不为 "control" 的插件（音源类，含 type 缺省） */
  const sourcePlugins = computed(() =>
    list.value.filter((info) => info.manifest.type !== "control"),
  );

  /** manifest.type === "control" 的插件（控制类） */
  const controlPlugins = computed(() =>
    list.value.filter((info) => info.manifest.type === "control"),
  );

  /** 拉取列表并建立状态订阅 */
  const load = async (): Promise<void> => {
    list.value = await window.api.plugins.list();
    loaded.value = true;
    if (!unsubscribe) {
      unsubscribe = window.api.plugins.onStatus((info) => {
        const next = list.value.slice();
        const idx = next.findIndex((item) => item.manifest.id === info.manifest.id);
        if (idx >= 0) next[idx] = info;
        else next.push(info);
        list.value = next;
      });
    }
  };

  /** 通过原生文件选择框导入插件 */
  const pickAndInstall = async (): Promise<{
    ok: boolean;
    id?: string;
    error?: string;
    cancelled?: boolean;
  }> => {
    const res = await window.api.plugins.pickAndInstall();
    if (res.ok) await load();
    return res;
  };

  /** 从远端 URL 下载并导入 */
  const installFromUrl = async (
    url: string,
  ): Promise<{ ok: boolean; id?: string; error?: string }> => {
    const res = await window.api.plugins.installFromUrl(url);
    if (res.ok) await load();
    return res;
  };

  const uninstall = async (id: string): Promise<{ ok: boolean; error?: string }> => {
    const res = await window.api.plugins.uninstall(id);
    if (res.ok) list.value = list.value.filter((info) => info.manifest.id !== id);
    return res;
  };

  /**
   * 启用或禁用指定插件。
   * - 控制类（type === "control"）：独立 toggle，多个可同时启用。
   * - 音源类（type 缺省或 "source"）：启用时互斥，先关闭其他已启用的音源。
   * @param id - 插件 ID
   * @param enabled - 目标启用状态
   */
  const setEnabled = async (id: string, enabled: boolean): Promise<void> => {
    const info = list.value.find((item) => item.manifest.id === id);
    if (!info) return;

    if (info.manifest.type === "control") {
      // 控制类：直接独立切换，不影响其他插件
      await window.api.plugins.setEnabled(id, enabled);
      return;
    }

    // 音源类：启用时先关闭其他已启用的音源（互斥）
    if (enabled) {
      for (const other of sourcePlugins.value) {
        if (other.manifest.id !== id && other.enabled) {
          await window.api.plugins.setEnabled(other.manifest.id, false);
        }
      }
    }
    await window.api.plugins.setEnabled(id, enabled);
  };

  /**
   * 启用指定插件，同时禁用其他所有已启用的音源插件（互斥）。
   * 保留供现有调用方（PluginManager.vue）使用；内部委托给 setEnabled。
   * @param id - 要启用的插件 ID
   */
  const enableExclusive = async (id: string): Promise<void> => {
    await setEnabled(id, true);
  };

  /**
   * 写入控制类插件的单个配置项。
   * @param id - 插件 ID
   * @param key - 配置项 key
   * @param value - 新值
   */
  const setSetting = async (id: string, key: string, value: unknown): Promise<void> => {
    await window.api.plugins.setSetting(id, key, value);
  };

  const dispose = (): void => {
    unsubscribe?.();
    unsubscribe = null;
  };

  return {
    list,
    loaded,
    sourcePlugins,
    controlPlugins,
    load,
    pickAndInstall,
    installFromUrl,
    uninstall,
    setEnabled,
    enableExclusive,
    setSetting,
    dispose,
  };
});
