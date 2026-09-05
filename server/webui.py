"""WebUI 管理后台页面：由 Python 动态生成 HTML 响应"""

from __future__ import annotations

PAGE_HTML = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SPlayer Together 管理后台</title>
  <style>
    :root {
      --bg: #0a0a0a;
      --panel: #171717;
      --border: #2a2a2a;
      --text: #e5e5e5;
      --muted: #8a8a8a;
      --accent: #6366f1;
      --danger: #ef4444;
      --ok: #22c55e;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 28px;
      width: 100%;
      max-width: 720px;
    }
    h1 { font-size: 20px; margin-bottom: 4px; }
    h2 { font-size: 15px; margin: 24px 0 12px; color: var(--muted); font-weight: 500; }
    .sub { color: var(--muted); font-size: 13px; margin-bottom: 20px; }
    .row { display: flex; gap: 8px; align-items: center; }
    input {
      flex: 1;
      background: #0f0f0f;
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      padding: 10px 12px;
      font-size: 14px;
      outline: none;
    }
    input:focus { border-color: var(--accent); }
    button {
      background: var(--accent);
      border: none;
      border-radius: 8px;
      color: #fff;
      padding: 10px 16px;
      font-size: 14px;
      cursor: pointer;
      white-space: nowrap;
    }
    button.ghost { background: transparent; border: 1px solid var(--border); color: var(--text); }
    button.danger { background: transparent; border: 1px solid var(--danger); color: var(--danger); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .list { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
    .item {
      display: flex;
      align-items: center;
      gap: 10px;
      background: #0f0f0f;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 14px;
    }
    .mono { font-family: "JetBrains Mono", Consolas, monospace; letter-spacing: 0.5px; }
    .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
    .tag { color: var(--muted); font-size: 12px; }
    .tag.ok { color: var(--ok); }
    .error { color: var(--danger); font-size: 13px; margin-top: 10px; }
    .notice { color: var(--muted); font-size: 12px; margin-top: 12px; line-height: 1.6; }
    .topbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .empty { color: var(--muted); font-size: 13px; text-align: center; padding: 16px 0; }
    .hidden { display: none !important; }
    .changelog {
      white-space: pre-wrap;
      background: #0f0f0f;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      font-size: 12px;
      line-height: 1.7;
      color: var(--muted);
      max-height: 260px;
      overflow: auto;
      margin-top: 12px;
    }
    .bar { height: 4px; background: #0f0f0f; border-radius: 2px; overflow: hidden; margin-top: 10px; }
    .bar > i { display: block; height: 100%; width: 0; background: var(--accent); transition: width .3s; }
  </style>
</head>
<body>
  <div class="card">
    <div class="topbar">
      <div>
        <h1>SPlayer Together 管理后台</h1>
        <div class="sub">管理一起听房间</div>
      </div>
      <div class="row" style="gap: 6px;">
        <button id="reloadBtn" class="ghost hidden">刷新配置</button>
        <button id="logoutBtn" class="ghost hidden">退出登录</button>
      </div>
    </div>

    <div id="loginView">
      <div class="row" style="margin-bottom: 8px;">
        <input id="username" placeholder="用户名" autocomplete="username" />
      </div>
      <div class="row">
        <input id="password" type="password" placeholder="密码" autocomplete="current-password" />
        <button id="loginBtn">登录</button>
      </div>
      <div id="loginError" class="error"></div>
    </div>

    <div id="adminView" class="hidden">
      <h2>进行中的房间</h2>
      <div id="roomsList" class="list"></div>

      <h2>服务器更新</h2>
      <div id="updatePanel">
        <div class="item">
          <span class="grow">
            <span id="updateStatusText">加载中…</span>
            <span class="tag" id="updateVersionInfo"></span>
          </span>
        </div>
        <div class="bar" id="updateBar" style="display:none;"><i id="updateBarFill"></i></div>
        <div class="row" style="margin-top: 10px;">
          <button id="checkUpdateBtn" class="ghost">检查更新</button>
          <button id="applyUpdateBtn" class="hidden">下载并安装</button>
          <button id="restartBtn" class="danger hidden">重启服务器</button>
          <button id="changelogBtn" class="ghost hidden">查看更新日志</button>
        </div>
        <div id="updateError" class="error"></div>
        <pre id="changelogView" class="changelog hidden"></pre>
      </div>
    </div>
  </div>

  <script>
    const $ = (id) => document.getElementById(id);
    const loginView = $("loginView");
    const adminView = $("adminView");
    const logoutBtn = $("logoutBtn");
    const reloadBtn = $("reloadBtn");

    let loggedIn = false;

    const api = async (path, options = {}) => {
      const res = await fetch(path, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...(options.headers || {}),
        },
      });
      if (res.status === 401 && path !== "/api/admin/login") {
        loggedIn = false;
        showLogin();
        throw new Error("unauthorized");
      }
      return res;
    };

    const showAdmin = () => {
      loggedIn = true;
      loginView.classList.add("hidden");
      adminView.classList.remove("hidden");
      logoutBtn.classList.remove("hidden");
      reloadBtn.classList.remove("hidden");
      refreshRooms();
      refreshUpdate();
    };

    const showLogin = () => {
      loggedIn = false;
      loginView.classList.remove("hidden");
      adminView.classList.add("hidden");
      logoutBtn.classList.add("hidden");
      reloadBtn.classList.add("hidden");
    };

    const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

    const refreshRooms = async () => {
      try {
        const res = await api("/api/admin/rooms");
        const data = await res.json();
        const list = $("roomsList");
        if (!data.rooms.length) {
          list.innerHTML = '<div class="empty">暂无进行中的房间</div>';
          return;
        }
        list.innerHTML = data.rooms.map((r) => {
          const playing = r.state && r.state.track ? r.state.track.title : "—";
          return `
            <div class="item">
              <span class="mono">${esc(r.code)}</span>
              <span class="tag grow">房主 ${esc(r.hostId.slice(0, 8))} · 在线 ${r.online}/${r.total} · ${esc(playing)}</span>
              <button class="danger" data-code="${esc(r.code)}">解散</button>
            </div>`;
        }).join("");
        list.querySelectorAll("[data-code]").forEach((btn) => {
          btn.addEventListener("click", async () => {
            await api(`/api/admin/rooms/${encodeURIComponent(btn.dataset.code)}/dissolve`, { method: "POST" });
            refreshRooms();
          });
        });
      } catch (e) { /* 忽略 */ }
    };

    const reloadConfig = async () => {
      try {
        const res = await api("/api/admin/reload", { method: "POST" });
        if (res.ok) {
          refreshRooms();
          alert("配置已刷新");
        }
      } catch (e) { /* 忽略 */ }
    };

    reloadBtn.addEventListener("click", reloadConfig);

    // ---------------- 服务器自更新 ----------------
    const STATUS_TEXT = {
      idle: "尚未检查更新",
      checking: "正在检查更新…",
      up_to_date: "已是最新版本",
      available: "发现新版本",
      downloading: "正在下载更新文件…",
      ready: "更新已下载，可安装",
      installing: "正在安装更新…",
      installed: "更新已安装，服务器即将重启…",
      error: "更新失败",
    };

    let updateInfo = null;

    const renderUpdate = (data) => {
      if (!data || !data.status) return;
      updateInfo = data;
      $("updateStatusText").textContent = STATUS_TEXT[data.status] || data.status;
      const parts = ["当前 v" + data.currentVersion];
      if (data.latestVersion) parts.push("最新 v" + data.latestVersion);
      if (!data.enabled) parts.push("自更新未启用");
      $("updateVersionInfo").textContent = " · " + parts.join(" · ");
      $("updateError").textContent = data.status === "error" ? (data.error || "") : "";
      const busy = ["checking", "downloading", "installing"].indexOf(data.status) >= 0;
      $("updateBar").style.display = busy ? "" : "none";
      $("updateBarFill").style.width = data.status === "downloading" ? "60%" : busy ? "100%" : "0";
      $("checkUpdateBtn").disabled = busy;
      $("applyUpdateBtn").classList.toggle("hidden", !(data.updateAvailable && data.enabled));
      $("changelogBtn").classList.toggle("hidden", !data.latestVersion);
      $("restartBtn").classList.toggle("hidden", ["ready", "installed"].indexOf(data.status) < 0);
      if (data.status === "installed") $("changelogView").classList.add("hidden");
    };

    const refreshUpdate = async () => {
      try {
        const res = await api("/api/admin/update/status");
        if (res.ok) renderUpdate(await res.json());
      } catch (e) { /* 忽略 */ }
    };

    const runUpdateAction = async (path, btn) => {
      if (btn) btn.disabled = true;
      $("updateError").textContent = "";
      try {
        const res = await api(path, { method: "POST" });
        const data = await res.json();
        if (!res.ok) {
          $("updateError").textContent = data.error || "操作失败";
        } else if (data.status) {
          renderUpdate(data);
        } else if (data.message) {
          $("updateStatusText").textContent = data.message;
        }
      } catch (e) {
        $("updateError").textContent = "无法连接服务器";
      } finally {
        if (btn) btn.disabled = false;
        refreshUpdate();
      }
    };

    $("checkUpdateBtn").addEventListener("click", () => runUpdateAction("/api/admin/update/check", $("checkUpdateBtn")));

    $("applyUpdateBtn").addEventListener("click", () => {
      const v = updateInfo && updateInfo.latestVersion ? updateInfo.latestVersion : "";
      if (!confirm("确定下载并安装 v" + v + " 吗？安装后服务器会自动重启。")) return;
      runUpdateAction("/api/admin/update/apply", $("applyUpdateBtn"));
    });

    $("restartBtn").addEventListener("click", () => {
      if (!confirm("确定重启服务器吗？房间状态将全部丢失。")) return;
      runUpdateAction("/api/admin/update/restart", $("restartBtn"));
    });

    $("changelogBtn").addEventListener("click", async () => {
      const view = $("changelogView");
      if (!view.classList.contains("hidden")) {
        view.classList.add("hidden");
        return;
      }
      const version = updateInfo && updateInfo.latestVersion ? updateInfo.latestVersion : "";
      try {
        const res = await api("/api/admin/update/changelog" + (version ? "?version=" + encodeURIComponent(version) : ""));
        const data = await res.json();
        view.textContent = data.markdown || data.error || "暂无更新日志";
      } catch (e) {
        view.textContent = "无法连接服务器";
      }
      view.classList.remove("hidden");
    });

    $("loginBtn").addEventListener("click", async () => {
      const username = $("username").value.trim();
      const password = $("password").value;
      $("loginError").textContent = "";
      try {
        const res = await fetch("/api/admin/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
        if (res.ok) {
          $("password").value = "";
          showAdmin();
        } else {
          $("loginError").textContent = "用户名或密码错误";
        }
      } catch (e) {
        $("loginError").textContent = "无法连接服务器";
      }
    });

    $("password").addEventListener("keydown", (e) => {
      if (e.key === "Enter") $("loginBtn").click();
    });

    logoutBtn.addEventListener("click", async () => {
      try { await api("/api/admin/logout", { method: "POST" }); } catch (e) { /* 忽略 */ }
      showLogin();
    });

    // 页面加载时校验 cookie 是否有效（401 会跳转回登录视图）
    (async () => {
      try {
        const res = await api("/api/admin/rooms");
        if (res.ok) showAdmin();
      } catch (e) { showLogin(); }
    })();

    setInterval(() => { if (loggedIn) { refreshRooms(); refreshUpdate(); } }, 10000);
  </script>
</body>
</html>
"""


def render_admin_page() -> str:
    """生成管理后台页面"""
    return PAGE_HTML