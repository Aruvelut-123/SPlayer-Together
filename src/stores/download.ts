/**
 * 下载任务镜像 store
 *
 * 权威态在主进程；本 store 拉取全量后订阅 onState/onProgress 增量更新，供下载页与侧边栏角标使用。
 * 用 shallowRef 持有任务数组，进度更新只替换对应元素。
 */

import type { DownloadTask, DownloadProgress } from "@shared/types/download";

export const useDownloadStore = defineStore("download", () => {
  /** 内存中保留的任务上限（与主进程历史裁剪对齐） */
  const MAX_TASKS = 200;

  const tasks = shallowRef<DownloadTask[]>([]);
  const initialized = ref(false);
  const unsubscribers: Array<() => void> = [];

  /** 进行中任务数（侧边栏角标） */
  const activeCount = computed(
    () =>
      tasks.value.filter((task) => task.status === "queued" || task.status === "downloading")
        .length,
  );

  /** 替换或插入一条任务 */
  const applyTask = (task: DownloadTask): void => {
    const idx = tasks.value.findIndex((item) => item.taskId === task.taskId);
    const next = tasks.value.slice();
    if (idx === -1) next.unshift(task);
    else next[idx] = task;
    // 最新在前，超限时丢弃最旧的（已结束任务在尾部）
    if (next.length > MAX_TASKS) next.length = MAX_TASKS;
    tasks.value = next;
  };

  /** 更新进度 */
  const applyProgress = (data: DownloadProgress): void => {
    const idx = tasks.value.findIndex((item) => item.taskId === data.taskId);
    if (idx === -1) return;
    const next = tasks.value.slice();
    next[idx] = { ...next[idx], received: data.received, total: data.total };
    tasks.value = next;
  };

  /** 拉取全量并订阅增量 */
  const init = async (): Promise<void> => {
    if (initialized.value) return;
    initialized.value = true;
    tasks.value = await window.api.download.list();
    unsubscribers.push(window.api.download.onState(applyTask));
    unsubscribers.push(window.api.download.onProgress(applyProgress));
  };

  const cancel = (taskId: string): void => void window.api.download.cancel(taskId);

  const remove = (taskId: string): void => {
    tasks.value = tasks.value.filter((item) => item.taskId !== taskId);
    void window.api.download.remove(taskId);
  };

  const clearFinished = (): void => {
    tasks.value = tasks.value.filter(
      (item) => item.status === "queued" || item.status === "downloading",
    );
    void window.api.download.clearFinished();
  };

  onScopeDispose(() => {
    for (const off of unsubscribers) off();
    unsubscribers.length = 0;
  });

  return { tasks, activeCount, init, cancel, remove, clearFinished };
});
