<script setup lang="ts">
import { useLicenseStore } from "@/stores/license";
import { toast } from "@/composables/useToast";
import IconLucideKeyRound from "~icons/lucide/key-round";
import IconLucideCopy from "~icons/lucide/copy";
import IconLucideRefreshCw from "~icons/lucide/refresh-cw";

const { t } = useI18n();
const license = useLicenseStore();
const { machineKey, checking, lastError } = storeToRefs(license);

const handleVerify = (): void => {
  void license.verify();
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
        <SFormItem :label="t('license.serverUrl')">
          <SInput
            v-model="license.serverUrl"
            placeholder="http://127.0.0.1:8000"
            type="url"
            clearable
          />
        </SFormItem>

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

        <SAlert v-if="lastError" type="error" class="mt-1">{{ lastError }}</SAlert>

        <SButton type="primary" size="large" class="w-full" :loading="checking" @click="handleVerify">
          <template #icon><IconLucideRefreshCw /></template>
          {{ t("license.verify") }}
        </SButton>

        <p class="text-xs leading-5 text-white/40">{{ t("license.hint") }}</p>
      </div>
    </div>
  </div>
</template>
