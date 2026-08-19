<script setup lang="ts">
import { useListenTogetherStore } from "@/stores/listenTogether";
import { toast } from "@/composables/useToast";
import IconLucideCopy from "~icons/lucide/copy";
import IconLucideRadio from "~icons/lucide/radio";
import IconLucideUserPlus from "~icons/lucide/user-plus";
import IconLucideLogOut from "~icons/lucide/log-out";
import IconLucideUsers from "~icons/lucide/users";
import IconLucideLoaderCircle from "~icons/lucide/loader-circle";

defineProps<{ open: boolean }>();
const emit = defineEmits<{ "update:open": [value: boolean] }>();

const { t } = useI18n();
const store = useListenTogetherStore();
const { connection, role, code, members, hostId, sharedState, permissions, lastError } =
  storeToRefs(store);

const joinCode = ref("");

/** 成员权限开关变化后同步到服务器 */
const handlePermissionChange = (): void => {
  void store.setPermissions({
    allowGuestControl: permissions.value.allowGuestControl,
    allowGuestEditPlaylist: permissions.value.allowGuestEditPlaylist,
  });
};

/** 连接状态文案与颜色 */
const connectionMeta = computed(() => {
  switch (connection.value) {
    case "connected":
      return { label: t("listenTogether.connected"), cls: "text-success" };
    case "connecting":
      return { label: t("listenTogether.connecting"), cls: "text-warning" };
    default:
      return { label: t("listenTogether.disconnected"), cls: "text-error" };
  }
});

const isHost = computed(() => role.value === "host");
/** 创建 / 加入请求进行中，防止重复点击 */
const busy = ref(false);

const sharedTrackText = computed(() => {
  const track = sharedState.value?.track;
  if (!track) return t("listenTogether.noSharedTrack");
  return `${track.title} - ${track.artists.map((a) => a.name).join(" / ")}`;
});

const handleCreate = async (): Promise<void> => {
  if (busy.value) return;
  busy.value = true;
  try {
    await store.createRoom();
  } finally {
    busy.value = false;
  }
};

const handleJoin = async (): Promise<void> => {
  if (busy.value || !joinCode.value.trim()) return;
  busy.value = true;
  try {
    await store.joinRoom(joinCode.value);
  } finally {
    busy.value = false;
  }
};

const handleLeave = (): void => {
  void store.leaveRoom();
};

const copyCode = async (): Promise<void> => {
  if (!code.value) return;
  try {
    await navigator.clipboard.writeText(code.value);
    toast.success(t("listenTogether.copied"));
  } catch {
    toast.error(t("listenTogether.copyFailed"));
  }
};
</script>

<template>
  <SDialog
    :open="open"
    :title="t('listenTogether.title')"
    width="480px"
    @update:open="emit('update:open', $event)"
  >
    <!-- 未入房：配置 + 创建/加入 -->
    <div v-if="role === 'none'" class="flex flex-col gap-3">
      <SFormItem :label="t('listenTogether.nickname')">
        <SInput
          v-model="store.nickname"
          :placeholder="t('listenTogether.nicknamePlaceholder')"
          :maxlength="24"
          clearable
        />
      </SFormItem>

      <SDivider class="my-1" />

      <div class="flex items-center gap-2">
        <SButton type="primary" class="flex-1" :loading="busy" :disabled="busy" @click="handleCreate">
          <template #icon><IconLucideRadio /></template>
          {{ t("listenTogether.createRoom") }}
        </SButton>
      </div>

      <div class="flex items-center gap-2">
        <SInput
          v-model="joinCode"
          :placeholder="t('listenTogether.roomCodePlaceholder')"
          clearable
          @keyup.enter="handleJoin"
        />
        <SButton :loading="busy" :disabled="busy || !joinCode.trim()" @click="handleJoin">
          <template #icon><IconLucideUserPlus /></template>
          {{ t("listenTogether.joinRoom") }}
        </SButton>
      </div>

      <SAlert v-if="lastError" type="error" class="mt-1">
        {{ lastError }}
      </SAlert>
      <p class="text-xs text-on-surface-variant/70 leading-5">
        {{ t("listenTogether.hint") }}
      </p>
    </div>

    <!-- 已入房：房间信息 + 成员 -->
    <div v-else class="flex flex-col gap-3">
      <SCard class="flex items-center gap-3 px-4 py-3">
        <IconLucideUsers class="size-5 text-primary shrink-0" />
        <div class="flex flex-col min-w-0">
          <div class="flex items-center gap-2">
            <span class="text-lg font-semibold tabular-nums">{{ code }}</span>
            <SButton variant="tertiary" :size="26" round @click="copyCode">
              <template #icon><IconLucideCopy class="size-3.5" /></template>
            </SButton>
            <STag :type="isHost ? 'primary' : 'default'" size="small">
              {{ isHost ? t("listenTogether.host") : t("listenTogether.guest") }}
            </STag>
          </div>
          <div class="flex items-center gap-1.5 text-xs mt-0.5">
            <span class="size-1.5 rounded-full" :class="connectionMeta.cls" />
            <span class="text-on-surface-variant">{{ connectionMeta.label }}</span>
          </div>
        </div>
        <div class="flex-1" />
        <SButton variant="secondary" size="small" @click="handleLeave">
          <template #icon><IconLucideLogOut /></template>
          {{ t("listenTogether.leaveRoom") }}
        </SButton>
      </SCard>

      <div class="flex flex-col gap-1.5">
        <span class="text-sm font-medium">{{ t("listenTogether.nowPlaying") }}</span>
        <SCard class="px-3 py-2.5">
          <div v-if="sharedState?.track" class="flex items-center gap-2 min-w-0">
            <SImg
              v-if="sharedState.track.cover"
              :src="sharedState.track.cover"
              class="size-9 rounded-md shrink-0"
            />
            <div class="flex flex-col min-w-0">
              <span class="text-sm truncate">{{ sharedTrackText }}</span>
              <span class="text-xs text-on-surface-variant/70">
                {{ sharedState.state === "playing" ? t("listenTogether.syncing") : t("listenTogether.paused") }}
              </span>
            </div>
          </div>
          <span v-else class="text-sm text-on-surface-variant">{{ sharedTrackText }}</span>
        </SCard>
      </div>

      <!-- 房主：成员权限控制 -->
      <div v-if="isHost" class="flex flex-col gap-1.5">
        <span class="text-sm font-medium">{{ t("listenTogether.memberPermissions") }}</span>
        <SCard class="px-3 py-2.5 flex flex-col gap-2">
          <div class="flex items-center justify-between gap-3">
            <span class="text-sm">{{ t("listenTogether.allowGuestControl") }}</span>
            <SSwitch
              :model-value="permissions.allowGuestControl"
              @update:model-value="
                permissions.allowGuestControl = $event;
                handlePermissionChange();
              "
            />
          </div>
          <div class="flex items-center justify-between gap-3">
            <span class="text-sm">{{ t("listenTogether.allowGuestEditPlaylist") }}</span>
            <SSwitch
              :model-value="permissions.allowGuestEditPlaylist"
              @update:model-value="
                permissions.allowGuestEditPlaylist = $event;
                handlePermissionChange();
              "
            />
          </div>
        </SCard>
      </div>

      <div class="flex flex-col gap-1.5">
        <span class="text-sm font-medium">
          {{ t("listenTogether.members", { count: members.length }) }}
        </span>
        <SCard class="px-3 py-2 flex flex-col gap-1.5 max-h-56 overflow-y-auto">
          <div
            v-for="member in members"
            :key="member.id"
            class="flex items-center gap-2 text-sm min-w-0"
          >
            <span class="truncate flex-1">
              {{ member.name }}
              <span v-if="member.id === hostId" class="text-xs text-primary">
                {{ t("listenTogether.host") }}
              </span>
            </span>
            <IconLucideLoaderCircle
              v-if="member.id === hostId && connection === 'connecting'"
              class="size-3.5 animate-spin text-on-surface-variant"
            />
            <SButton
              v-if="isHost && member.id !== hostId"
              variant="ghost"
              size="small"
              @click="store.transferHost(member.id)"
            >
              {{ t("listenTogether.transferHost") }}
            </SButton>
          </div>
        </SCard>
      </div>
    </div>
  </SDialog>
</template>
