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
  </style>
</head>
<body>
  <div class="card">
    <div class="topbar">
      <div>
        <h1>SPlayer Together 管理后台</h1>
        <div class="sub">管理机器授权密钥与一起听房间</div>
      </div>
      <button id="logoutBtn" class="ghost hidden">退出登录</button>
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
      <h2>密钥白名单</h2>
      <div class="row">
        <input id="newKey" class="mono" placeholder="XXXX-XXXX-XXXX-XXXX" maxlength="19" />
        <button id="addKeyBtn">添加密钥</button>
      </div>
      <div id="keysList" class="list"></div>
      <div class="notice">客户端按机器 ID 生成的密钥需加入此白名单后，软件才能通过授权校验（每 5 分钟复核一次）。</div>

      <h2>进行中的房间</h2>
      <div id="roomsList" class="list"></div>
    </div>
  </div>

  <script>
    const tokenKey = "spt_admin_token";
    let token = localStorage.getItem(tokenKey) || "";

    const $ = (id) => document.getElementById(id);
    const loginView = $("loginView");
    const adminView = $("adminView");
    const logoutBtn = $("logoutBtn");

    const api = async (path, options = {}) => {
      const res = await fetch(path, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          "X-Admin-Token": token,
          ...(options.headers || {}),
        },
      });
      if (res.status === 401 && path !== "/api/admin/login") {
        token = "";
        localStorage.removeItem(tokenKey);
        showLogin();
        throw new Error("unauthorized");
      }
      return res;
    };

    const showAdmin = () => {
      loginView.classList.add("hidden");
      adminView.classList.remove("hidden");
      logoutBtn.classList.remove("hidden");
      refreshKeys();
      refreshRooms();
    };

    const showLogin = () => {
      loginView.classList.remove("hidden");
      adminView.classList.add("hidden");
      logoutBtn.classList.add("hidden");
    };

    const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

    const refreshKeys = async () => {
      try {
        const res = await api("/api/admin/keys");
        const data = await res.json();
        const list = $("keysList");
        if (!data.keys.length) {
          list.innerHTML = '<div class="empty">暂无密钥</div>';
          return;
        }
        list.innerHTML = data.keys.map((k) => `
          <div class="item">
            <span class="mono grow">${esc(k)}</span>
            <button class="danger" data-del="${esc(k)}">删除</button>
          </div>`).join("");
        list.querySelectorAll("[data-del]").forEach((btn) => {
          btn.addEventListener("click", async () => {
            await api(`/api/admin/keys/${encodeURIComponent(btn.dataset.del)}`, { method: "DELETE" });
            refreshKeys();
          });
        });
      } catch (e) { /* 忽略 */ }
    };

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
          const data = await res.json();
          token = data.token;
          localStorage.setItem(tokenKey, token);
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

    $("addKeyBtn").addEventListener("click", async () => {
      const key = $("newKey").value.trim().toUpperCase();
      if (!key) return;
      const res = await api("/api/admin/keys", {
        method: "POST",
        body: JSON.stringify({ key }),
      });
      if (res.ok) {
        $("newKey").value = "";
        refreshKeys();
      }
    });

    $("newKey").addEventListener("keydown", (e) => {
      if (e.key === "Enter") $("addKeyBtn").click();
    });

    logoutBtn.addEventListener("click", async () => {
      try { await api("/api/admin/logout", { method: "POST" }); } catch (e) { /* 忽略 */ }
      token = "";
      localStorage.removeItem(tokenKey);
      showLogin();
    });

    if (token) {
      (async () => {
        try {
          const res = await api("/api/admin/keys");
          if (res.ok) showAdmin();
        } catch (e) { showLogin(); }
      })();
    } else {
      showLogin();
    }

    setInterval(() => { if (token) { refreshRooms(); } }, 10000);
  </script>
</body>
</html>
"""


def render_admin_page() -> str:
    """生成管理后台页面"""
    return PAGE_HTML
