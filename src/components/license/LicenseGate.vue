<script setup lang="ts">
import { useLicenseStore } from "@/stores/license";
import { useUpdateStore } from "@/stores/update";
import { toast } from "@/composables/useToast";
import IconLucideKeyRound from "~icons/lucide/key-round";
import IconLucideCopy from "~icons/lucide/copy";
import IconLucideRefreshCw from "~icons/lucide/refresh-cw";
import IconLucideDownload from "~icons/lucide/download";

const { t } = useI18n();
const license = useLicenseStore();
const update = useUpdateStore();
const { machineKey, checking, lastError } = storeToRefs(license);

/** 有可用更新时不允许继续使用 */
const hasBlockingUpdate = computed(() => update.hasUpdate);

const handleVerify = (): void => {
  void license.verify();
};

const handleContinue = (): void => {
  license.continueWithoutAuth();
};

const handleUpdate = (): void => {
  if (update.canInstall) {
    update.download();
  } else {
    update.openDownloadPage();
  }
};

const copyKey = async (): Promise<void> => {
  if (!machineKey.value) return;
  try {
    await navigator.clipboard.writeText(machineKey.value);
    toast.success(t("license.copied"));
  } catch {
    toast.error(t("license.copyFailed"));
  }
};

onMounted(() => {
  void (async () => {
    // 授权前先强制检查更新：有新版本则必须先更新
    update.checkManually();
    await license.loadMachineKey();
    await license.verify();
  })();
});
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950 px-4">
    <div
      class="w-full max-w-md rounded-2xl border border-white/10 bg-white/5 p-6 shadow-2xl backdrop-blur-xl"
    >
      <div class="mb-1 flex items-center gap-2">
        <IconLucideKeyRound class="size-6 text-primary" />
        <h1 class="text-xl font-semibold text-white">SPlayer Together</h1>
      </div>
      <p class="mb-5 text-sm leading-5 text-white/60">{{ t("license.subtitle") }}</p>

      <div class="flex flex-col gap-3">
        <SFormItem :label="t('license.machineKey')">
          <div class="flex items-center gap-2">
            <div class="flex h-9 flex-1 items-center rounded-lg border border-white/10 bg-black/30 px-3">
              <IconLucideKeyRound class="mr-2 size-4 shrink-0 text-white/40" />
              <span class="truncate font-mono text-sm tabular-nums text-white">
                {{ machineKey || t("license.generating") }}
              </span>
            </div>
            <SButton
              variant="secondary"
              :size="34"
              round
              :disabled="!machineKey"
              @click="copyKey"
            >
              <template #icon><IconLucideCopy class="size-4" /></template>
            </SButton>
          </div>
        </SFormItem>

        <!-- 有可用更新：必须更新后才能继续 -->
        <template v-if="hasBlockingUpdate">
          <SAlert type="warning" class="mt-1">{{ t("license.updateRequired") }}</SAlert>
          <SButton type="primary" size="large" class="w-full" @click="handleUpdate">
            <template #icon><IconLucideDownload /></template>
            {{ update.canInstall ? t("update.download") : t("update.goDownload") }}
          </SButton>
        </template>

        <!-- 无更新（或无法检查）：验证授权或跳过继续使用 -->
        <template v-else>
          <SAlert v-if="lastError" type="error" class="mt-1">{{ lastError }}</SAlert>
          <SButton
            type="primary"
            size="large"
            class="w-full"
            :loading="checking"
            :disabled="update.phase === 'checking'"
            @click="handleVerify"
          >
            <template #icon><IconLucideRefreshCw /></template>
            {{ t("license.verify") }}
          </SButton>
          <SButton
            variant="secondary"
            size="large"
            class="w-full"
            :disabled="update.phase === 'checking'"
            @click="handleContinue"
          >
            {{ t("license.continueUse") }}
          </SButton>
        </template>

        <p class="text-xs leading-5 text-white/40">{{ t("license.hint") }}</p>
      </div>
    </div>
  </div>
</template>
