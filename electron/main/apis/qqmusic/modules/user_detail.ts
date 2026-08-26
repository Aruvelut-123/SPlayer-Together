/**
 * QM 用户基础资料模块
 *
 * 通过登录 Cookie 中的 uin 及官方接口获取用户信息
 */

import { getQQMusicCookies, getQQMusicUin, qmRequest } from "../core/request";
import { coreLog } from "@main/utils/logger";
import type { QMModule } from "../core/types";

interface UserBaseInfoData {
  vec_user_info?: Array<{
    uin?: string;
    nick?: string;
    headpic?: string;
    icon?: string;
    vip_flag?: number;
    vip_level?: number;
    is_vip?: number;
    is_super_vip?: number;
  }>;
}

const userDetail: QMModule = async (_params) => {
  const cookies = getQQMusicCookies();
  const uin = getQQMusicUin();

  const hasKey = !!(
    cookies.qm_keyst ||
    cookies.qqmusic_key ||
    cookies.pskey ||
    cookies.p_skey ||
    cookies.skey
  );

  coreLog.info("[qm-user-detail] 获取登录状态与资料:", {
    uin,
    hasKey,
    cookieKeys: Object.keys(cookies),
  });

  if (!uin || uin === "0" || !hasKey) {
    return {
      code: 301,
      loggedIn: false,
      message: "未登录 QM 账号",
    };
  }

  // 默认头像由 QQ 头像规范构造
  const defaultAvatar = `https://q.qlogo.cn/headimg_dl?dst_uin=${uin}&spec=100`;

  try {
    const data = await qmRequest<UserBaseInfoData>("music.UserBaseInfoServer", "GetUserBaseInfo", {
      vec_uin: [uin],
    });

    const user = data?.vec_user_info?.[0];
    const nickname = user?.nick || `QQ用户_${uin.slice(-4)}`;
    const avatarUrl = user?.headpic || defaultAvatar;
    const isVip = !!(user?.is_vip || user?.is_super_vip || (user?.vip_flag && user.vip_flag > 0));

    coreLog.info("[qm-user-detail] 成功获取用户资料:", {
      uin,
      nickname,
      isVip,
      vipLevel: user?.vip_level ?? 0,
    });

    return {
      code: 200,
      loggedIn: true,
      profile: {
        userId: uin,
        nickname,
        avatarUrl,
        isVip,
        vipLevel: user?.vip_level ?? 0,
      },
    };
  } catch (err) {
    coreLog.warn("[qm-user-detail] 官方接口调用失败，使用基础 UIN 兜底资料:", err);
    // 接口异常时回退到纯 UIN 的基础身份
    return {
      code: 200,
      loggedIn: true,
      profile: {
        userId: uin,
        nickname: `QQ用户_${uin.slice(-4)}`,
        avatarUrl: defaultAvatar,
        isVip: false,
      },
    };
  }
};

export default userDetail;
