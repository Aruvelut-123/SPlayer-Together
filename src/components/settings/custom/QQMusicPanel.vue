<script setup lang="ts">
import { toast } from "@/composables/useToast";
import {
  fetchQQMusicLoginStatus,
  openQQMusicLoginWeb,
  logoutQQMusic,
  setQQMusicCookie,
  type QQMusicProfile,
} from "@/apis/login/qqmusic";
import IconLucideMusic from "~icons/lucide/music";
import IconLucideUnplug from "~icons/lucide/unplug";
import IconLucideLogIn from "~icons/lucide/log-in";
import IconLucideKey from "~icons/lucide/key";
import vipImg from "@/assets/images/vip.png";

defineOptions({ inheritAttrs: false });

const { t } = useI18n();

const PLATFORM = "QM";
const CACHE_KEY = "splayer:qm_profile";

const getCachedProfile = (): QQMusicProfile | null => {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as QQMusicProfile) : null;
  } catch {
    return null;
  }
};

const setCachedProfile = (p: QQMusicProfile | null): void => {
  try {
    if (p) localStorage.setItem(CACHE_KEY, JSON.stringify(p));
    else localStorage.removeItem(CACHE_KEY);
  } catch {
    // ignore
  }
};

const profile = ref<QQMusicProfile | null>(getCachedProfile());
const loggingIn = ref(false);
const confirmOpen = ref(false);
const cookieModalOpen = ref(false);
const cookieSubmitting = ref(false);
const manualCookie = ref("");

watch(cookieModalOpen, (val) => {
  if (!val) {
    manualCookie.value = "";
    cookieSubmitting.value = false;
  }
});

/** 刷新登录状态并同步本地缓存 */
const refresh = async (): Promise<void> => {
  const latest = await fetchQQMusicLoginStatus();
  profile.value = latest;
  setCachedProfile(latest);
};

onMounted(refresh);

/** 发起网页登录 */
const handleLogin = async (): Promise<void> => {
  loggingIn.value = true;
  try {
    const ok = await openQQMusicLoginWeb();
    if (ok) {
      await refresh();
      if (profile.value) {
        toast.success(
          t("settings.platformLogin.toast.loginSuccess", {
            name: PLATFORM,
            user: profile.value.nickname,
          }),
        );
      } else {
        toast.error(t("settings.platformLogin.toast.loginFailed", { name: PLATFORM }));
      }
    }
  } catch (err) {
    toast.error(t("settings.platformLogin.toast.loginFailed", { name: PLATFORM }));
    console.error(err);
  } finally {
    loggingIn.value = false;
  }
};

/** 断开连接 / 登出 */
const handleDisconnect = async (): Promise<void> => {
  confirmOpen.value = false;
  await logoutQQMusic();
  profile.value = null;
  setCachedProfile(null);
  toast.success(t("settings.platformLogin.toast.logoutDone", { name: PLATFORM }));
};

/** 手动输入 Cookie 提交 */
const handleManualCookieSubmit = async (): Promise<void> => {
  const cookieStr = manualCookie.value.trim();
  if (!cookieStr || cookieSubmitting.value) return;

  cookieSubmitting.value = true;
  try {
    const ok = await setQQMusicCookie(cookieStr);
    if (!ok) {
      toast.error(t("settings.platformLogin.toast.cookieInvalid"));
      return;
    }

    const latest = await fetchQQMusicLoginStatus();
    if (latest) {
      profile.value = latest;
      setCachedProfile(latest);
      cookieModalOpen.value = false;
      manualCookie.value = "";
      toast.success(t("settings.platformLogin.toast.cookieSuccess", { name: PLATFORM }));
    } else {
      await logoutQQMusic();
      profile.value = null;
      setCachedProfile(null);
      toast.error(t("settings.platformLogin.toast.cookieInvalid"));
    }
  } catch (err) {
    toast.error(t("settings.platformLogin.toast.cookieInvalid"));
    console.error(err);
  } finally {
    cookieSubmitting.value = false;
  }
};
</script>

<template>
  <div class="flex flex-col gap-3">
    <div
      class="flex items-center justify-between gap-4 rounded-xl bg-surface-panel border border-solid border-outline-variant/15 px-4 py-3.5"
    >
      <div class="flex items-center gap-3 min-w-0 flex-1">
        <span
          v-if="profile?.avatarUrl"
          class="size-10 rounded-full overflow-hidden bg-on-surface/10 flex items-center justify-center shrink-0 border border-solid border-outline-variant/20"
        >
          <img
            :src="profile.avatarUrl"
            alt="avatar"
            class="size-full object-cover"
            referrerpolicy="no-referrer"
          />
        </span>
        <div
          v-else
          class="size-10 rounded-xl bg-on-surface/6 flex items-center justify-center text-on-surface-variant shrink-0"
        >
          <IconLucideMusic class="size-5" />
        </div>
        <div class="min-w-0">
          <div class="flex items-center gap-2 text-base">
            <span class="truncate">
              {{
                profile ? profile.nickname : t("settings.platformLogin.title", { name: PLATFORM })
              }}
            </span>
            <img v-if="profile?.isVip" :src="vipImg" alt="VIP" class="h-3.5 shrink-0" />
          </div>
          <div class="text-sm text-on-surface-variant/70 mt-0.5 truncate">
            {{
              profile
                ? `UIN: ${profile.userId}${profile.isVip ? t("settings.platformLogin.vipTag") : ""}`
                : t("settings.platformLogin.desc")
            }}
          </div>
        </div>
      </div>

      <div class="shrink-0 flex items-center gap-2">
        <template v-if="profile">
          <SButton variant="secondary" size="small" type="error" @click="confirmOpen = true">
            <template #icon>
              <IconLucideUnplug class="size-4" />
            </template>
            {{ t("settings.platformLogin.logout") }}
          </SButton>
        </template>
        <template v-else>
          <SButton variant="secondary" size="small" @click="cookieModalOpen = true">
            <template #icon>
              <IconLucideKey class="size-3.5" />
            </template>
            {{ t("settings.platformLogin.manualCookie") }}
          </SButton>
          <SButton
            variant="secondary"
            size="small"
            type="primary"
            :loading="loggingIn"
            @click="handleLogin"
          >
            <template #icon>
              <IconLucideLogIn class="size-4" />
            </template>
            {{ t("settings.platformLogin.loginWeb") }}
          </SButton>
        </template>
      </div>
    </div>

    <!-- 退出确认弹窗 -->
    <SDialog
      v-model:open="confirmOpen"
      :title="t('settings.platformLogin.logoutTitle', { name: PLATFORM })"
      width="400px"
    >
      <p class="text-sm text-on-surface-variant">
        {{
          t("settings.platformLogin.logoutConfirm", {
            name: PLATFORM,
            user: profile?.nickname || "",
          })
        }}
      </p>
      <template #footer="{ close }">
        <SButton variant="tertiary" @click="close">{{ t("common.cancel") }}</SButton>
        <SButton variant="secondary" type="error" @click="handleDisconnect">
          {{ t("common.confirm") }}
        </SButton>
      </template>
    </SDialog>

    <!-- 手动输入 Cookie 弹窗 -->
    <SDialog
      v-model:open="cookieModalOpen"
      :title="t('settings.platformLogin.cookieTitle', { name: PLATFORM })"
      width="450px"
    >
      <div class="flex flex-col gap-3 py-1">
        <SInput
          v-model="manualCookie"
          type="textarea"
          :rows="4"
          clearable
          :disabled="cookieSubmitting"
          :placeholder="t('settings.platformLogin.cookiePlaceholder')"
        />
      </div>
      <template #footer="{ close }">
        <SButton variant="tertiary" :disabled="cookieSubmitting" @click="close">
          {{ t("common.cancel") }}
        </SButton>
        <SButton type="primary" :loading="cookieSubmitting" @click="handleManualCookieSubmit">
          {{ t("common.confirm") }}
        </SButton>
      </template>
    </SDialog>
  </div>
</template>
