<script setup lang="ts">
import type { PlaylistScope } from "@shared/types/content";
import { usePlaylistStore } from "@/stores/playlist";
import { useUserStore } from "@/stores/user";
import { toast } from "@/composables/useToast";

const props = defineProps<{
  open: boolean;
  /** 默认新建类型 */
  mode: PlaylistScope;
  /** 预填歌单名 */
  initialName?: string;
}>();
const emit = defineEmits<{
  "update:open": [value: boolean];
  /** 新建成功：歌单 id + 实际类型 */
  created: [playlistId: string, scope: PlaylistScope];
}>();

const { t } = useI18n();
const playlistStore = usePlaylistStore();
const userStore = useUserStore();

const scope = ref<PlaylistScope>(props.mode);
const name = ref("");
const privacy = ref<0 | 10>(0);
const remoteType = ref("webdav");
const url = ref("");
const username = ref("");
const password = ref("");
const rootPath = ref("");
const scanDepth = ref(2);
const submitting = ref(false);

const typeTabs = computed(() => [
  { key: "local", label: t("collection.localPlaylist") },
  { key: "online", label: t("collection.onlinePlaylist") },
  { key: "remote", label: t("collection.remotePlaylist") },
]);
const remoteTypeOptions = computed(() => [{ value: "webdav", label: "WebDAV" }]);
const canSubmit = computed(
  () => Boolean(name.value.trim()) && (scope.value !== "remote" || Boolean(url.value.trim())),
);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    scope.value = props.mode;
    name.value = props.initialName?.trim() ?? "";
    privacy.value = 0;
    remoteType.value = "webdav";
    url.value = "";
    username.value = "";
    password.value = "";
    rootPath.value = "";
    scanDepth.value = 2;
    submitting.value = false;
  },
);

const handleConfirm = async (): Promise<void> => {
  const title = name.value.trim();
  if (!canSubmit.value || submitting.value) return;
  submitting.value = true;
  try {
    let id: string | undefined;
    if (scope.value === "local") {
      id = (await playlistStore.create(title)).id;
    } else if (scope.value === "remote") {
      id = (
        await playlistStore.createRemote(title, {
          url: url.value,
          username: username.value,
          password: password.value,
          rootPath: rootPath.value,
          scanDepth: scanDepth.value,
        })
      ).id;
    } else {
      id = (await userStore.createPlaylist(title, privacy.value)).id;
    }
    if (!id) {
      toast.error(t("liked.toast.failed"));
      return;
    }
    emit("created", id, scope.value);
    emit("update:open", false);
  } catch (error) {
    const message =
      error instanceof Error && error.message ? error.message : t("liked.toast.failed");
    toast.error(message);
  } finally {
    submitting.value = false;
  }
};
</script>

<template>
  <SDialog
    :open="open"
    :title="t('collection.create', { type: t('collection.playlist') })"
    width="480px"
    @update:open="(value) => emit('update:open', value)"
  >
    <STabs v-model="scope" :tabs="typeTabs" type="segment" animated>
      <template #local>
        <div class="flex flex-col gap-4 pt-4">
          <label class="flex flex-col gap-1">
            <span class="text-xs text-on-surface-variant">
              {{ t("collection.name", { type: t("collection.playlist") }) }}
            </span>
            <SInput
              v-model="name"
              :placeholder="t('collection.playlistNamePlaceholder')"
              :disabled="submitting"
              clearable
              @keyup.enter="handleConfirm"
            />
          </label>
        </div>
      </template>

      <template #remote>
        <div class="flex flex-col gap-4 pt-4">
          <label class="flex flex-col gap-1">
            <span class="text-xs text-on-surface-variant">{{ t("collection.remoteType") }}</span>
            <SSelect v-model="remoteType" :options="remoteTypeOptions" :disabled="submitting" />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-xs text-on-surface-variant">
              {{ t("collection.name", { type: t("collection.playlist") }) }}
            </span>
            <SInput
              v-model="name"
              :placeholder="t('collection.playlistNamePlaceholder')"
              :disabled="submitting"
              clearable
              @keyup.enter="handleConfirm"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-xs text-on-surface-variant">{{ t("collection.webdav.url") }}</span>
            <SInput
              v-model="url"
              type="url"
              placeholder="https://dav.example.com"
              :disabled="submitting"
              clearable
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-xs text-on-surface-variant">
              {{ t("collection.webdav.username") }}
            </span>
            <SInput v-model="username" :disabled="submitting" />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-xs text-on-surface-variant">
              {{ t("collection.webdav.password") }}
            </span>
            <SInput v-model="password" type="password" :disabled="submitting" />
          </label>
          <div class="grid grid-cols-[minmax(0,1fr)_9rem] gap-3">
            <label class="flex min-w-0 flex-col gap-1">
              <span class="text-xs text-on-surface-variant">
                {{ t("collection.webdav.mountPath") }}
              </span>
              <SInput
                v-model="rootPath"
                placeholder="/"
                :disabled="submitting"
                clearable
                @keyup.enter="handleConfirm"
              />
            </label>
            <div class="flex flex-col gap-1">
              <label for="webdav-scan-depth" class="text-xs text-on-surface-variant">
                {{ t("collection.webdav.scanDepth") }}
              </label>
              <SNumberInput
                id="webdav-scan-depth"
                v-model="scanDepth"
                class="w-full"
                :min="0"
                :max="10"
                :unit="t('collection.webdav.depthUnit')"
                :disabled="submitting"
              />
            </div>
          </div>
        </div>
      </template>

      <template #online>
        <div class="flex flex-col gap-4 pt-4">
          <label class="flex flex-col gap-1">
            <span class="text-xs text-on-surface-variant">
              {{ t("collection.name", { type: t("collection.playlist") }) }}
            </span>
            <SInput
              v-model="name"
              :placeholder="t('collection.playlistNamePlaceholder')"
              :disabled="submitting"
              clearable
              @keyup.enter="handleConfirm"
            />
          </label>
          <div class="flex items-center gap-2">
            <span class="text-on-surface">{{ t("collection.privacy.private") }}</span>
            <SSwitch
              :model-value="privacy === 10"
              :disabled="submitting"
              @update:model-value="(value: boolean) => (privacy = value ? 10 : 0)"
            />
          </div>
        </div>
      </template>
    </STabs>

    <template #footer="{ close }">
      <SButton variant="tertiary" :disabled="submitting" @click="close">
        {{ t("common.cancel") }}
      </SButton>
      <SButton type="primary" :disabled="!canSubmit" :loading="submitting" @click="handleConfirm">
        {{ t("common.confirm") }}
      </SButton>
    </template>
  </SDialog>
</template>
