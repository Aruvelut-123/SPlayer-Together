<script setup lang="ts">
import { toast } from "@/composables/useToast";
import { useCopyText } from "@/composables/useCopyText";
import { useSettingsStore } from "@/stores/settings";
import type { McpClientConfigParams } from "@shared/types/settings";
import IconLucideCopy from "~icons/lucide/copy";

defineOptions({ inheritAttrs: false });

const { t } = useI18n();
const { copy } = useCopyText();
const settings = useSettingsStore();
const open = ref(false);
const params = ref<McpClientConfigParams>({
  port: settings.system.mcp.port,
  accessKey: "********************************",
});

const clientConfig = computed(() =>
  JSON.stringify(
    {
      mcpServers: {
        "splayer-next": {
          type: "http",
          url: `http://127.0.0.1:${params.value.port}/mcp`,
          headers: { "X-MCP-Key": params.value.accessKey },
        },
      },
    },
    null,
    2,
  ),
);

watch(open, async (value) => {
  if (!value) return;

  try {
    params.value = await window.api.mcp.getClientConfigParams();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  }
});
</script>

<template>
  <SButton type="primary" variant="secondary" size="small" @click="open = true">
    {{ t("common.configure") }}
  </SButton>

  <SDialog v-model:open="open" :title="t('settings.mcpConfigDetails.label')" width="600px">
    <div class="flex flex-col gap-3">
      <div class="relative rounded-lg bg-on-surface/5 overflow-hidden">
        <pre
          class="m-0 px-4 py-3.5 pr-14 overflow-x-auto font-sans text-sm leading-6 text-on-surface-variant tabular-nums"
          >{{ clientConfig }}</pre
        >
        <SButton class="absolute right-2 top-2" variant="ghost" circle @click="copy(clientConfig)">
          <template #icon><IconLucideCopy /></template>
        </SButton>
      </div>
      <p class="m-0 text-sm text-on-surface-variant/75 text-pretty">
        {{ t("settings.mcp.configHint") }}
      </p>
    </div>

    <template #footer="{ close }">
      <SButton type="primary" @click="close">{{ t("common.close") }}</SButton>
    </template>
  </SDialog>
</template>
