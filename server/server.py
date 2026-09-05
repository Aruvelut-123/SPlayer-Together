#!/usr/bin/env python3
"""SPlayer Together 中继服务器（纯 HTTP 轮询版）

职责：
1. 一起听中继：房主周期性推送播放状态与队列，成员周期性拉取并跟随，全部走纯 HTTP，
   不使用 WebSocket，部署简单且不易断线。
2. WebUI 管理后台：登录后查看与管理房间。

配置在 ``config.yml``。运行：

    pip install -r requirements.txt
    python server.py
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import secrets
import shutil
import string
import subprocess
import sys
import threading
import time
import urllib.parse
from pathlib import Path
from typing import Any

import yaml
from aiohttp import ClientSession, ClientTimeout, web

from webui import render_admin_page

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("relay")

BASE_DIR = Path(__file__).parent
CONFIG_FILE = BASE_DIR / "config.yml"

CODE_ALPHABET = string.ascii_uppercase + string.digits
ROOM_CODE_LEN = 6

# 成员超过该时长未请求视为离线
MEMBER_TIMEOUT_MS = 60_000
# 无在线成员的房间超过该时长后清理（仅清理无人在线的房间）
ROOM_TTL_MS = 2 * 60 * 1000
# 后台清理任务间隔
CLEANUP_INTERVAL_MS = 30_000

# 服务器自身版本（与 changelogs/<version>.md 对应）
SERVER_VERSION = "1.2.0"

# 更新包静态目录（setup / portable exe 放这里供 /downloads 下载）
DOWNLOADS_DIR = BASE_DIR / "downloads"
DOWNLOADS_DIR.mkdir(exist_ok=True)
# 更新日志按版本文件目录（供 /api/admin/update/changelog 读取）
CHANGELOGS_DIR = BASE_DIR / "changelogs"
# 自更新源文件：从最新 release 的 tag 拉取 raw 文件后原子替换
UPDATE_FILES = ("server.py", "webui.py", "requirements.txt")
# 下载暂存目录（全部校验通过后才替换到 BASE_DIR）
UPDATE_STAGING_DIR = BASE_DIR / ".update-staging"
# 替换前的备份目录（backups/<旧版本>-<时间戳>/）
BACKUP_DIR = BASE_DIR / "backups"
# 更新状态持久化文件（重启后仍能告诉管理端“有新版本待安装”）
UPDATE_STATE_FILE = BASE_DIR / "update-state.json"

# 更新源：GitHub Releases
RELEASES_API_URL = "https://api.github.com/repos/{repo}/releases/latest"
RELEASE_PAGE_URL = "https://github.com/{repo}/releases/latest"
RAW_FILE_URL = "https://raw.githubusercontent.com/{repo}/{tag}/{file}"
RELEASE_TIMEOUT_S = 30
# 启动后首次自动检查的延迟（秒）
UPDATE_STARTUP_CHECK_DELAY_S = 5

# 版本号（用于 changelog 查询参数）与 server.py 中的版本定义
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")
SERVER_VERSION_RE = re.compile(r"""^SERVER_VERSION\s*=\s*["']([^"']+)["']""", re.M)
REQUIREMENT_RE = re.compile(r"^[A-Za-z0-9._-]+(\[[A-Za-z0-9,._ -]+\])?([=<>!~]=?[^\s;#]+)?$")

DEFAULT_CONFIG: dict[str, Any] = {
    "host": "0.0.0.0",
    "port": 8000,
    "update": {
        "enabled": False,           # 是否启用服务器自更新
        "github_repo": "",          # 更新源仓库 owner/repo
        "github_token": "",         # 可选：私有仓库 / 提高 API 限额
        "check_interval_minutes": 60,  # 后台检查间隔（分钟）
    },
    "admin": {"username": "admin", "password": "change-me"},
}


def now_ms() -> int:
    """服务器毫秒时间戳"""
    return int(time.time() * 1000)


def load_config() -> dict[str, Any]:
    data: dict[str, Any] = {}
    if CONFIG_FILE.exists():
        data = yaml.safe_load(CONFIG_FILE.read_text(encoding="utf-8")) or {}
    config = {**DEFAULT_CONFIG, **data}
    config["admin"] = {**DEFAULT_CONFIG["admin"], **(data.get("admin") or {})}
    config["update"] = {**DEFAULT_CONFIG["update"], **(data.get("update") or {})}
    return config


def update_config() -> dict[str, Any]:
    """当前生效的更新相关配置（兼容 repo / check_interval 简写）"""
    cfg = CONFIG.get("update") or {}
    merged = {**DEFAULT_CONFIG["update"], **{k: v for k, v in cfg.items() if v is not None}}
    if not merged.get("github_repo") and merged.get("repo"):
        merged["github_repo"] = merged["repo"]
    if cfg.get("check_interval") is not None and cfg.get("check_interval_minutes") is None:
        merged["check_interval_minutes"] = cfg["check_interval"]
    return merged


def update_cfg_value(key: str, fallback: Any) -> Any:
    """读取单个更新配置项，缺省或空值时回退到默认"""
    value = update_config().get(key, fallback)
    return fallback if value is None else value


def update_cfg_bool(key: str) -> bool:
    return bool(update_cfg_value(key, False))


def update_cfg_int(key: str, fallback: int) -> int:
    try:
        return int(update_cfg_value(key, fallback))
    except (TypeError, ValueError):
        return fallback


def update_cfg_str(key: str) -> str:
    value = update_cfg_value(key, "")
    return str(value).strip()


CONFIG = load_config()
ADMIN_USERNAME: str = str(CONFIG["admin"]["username"])
ADMIN_PASSWORD: str = str(CONFIG["admin"]["password"])

admin_tokens: set[str] = set()

# code -> Room
rooms: dict[str, "Room"] = {}


# --------------------------------------------------------------------------
# 服务器自身更新：状态模型
# --------------------------------------------------------------------------


class UpdateError(RuntimeError):
    """自更新失败，消息可直接展示给管理端"""


# 更新状态机：idle -> checking -> up_to_date | available
#                        -> downloading -> ready -> installing -> installed
# 任一环节失败都会转入 error，并带上可展示的中文错误信息
UPDATE_STATE: dict[str, Any] = {
    "status": "idle",          # idle | checking | up_to_date | available | downloading | ready | installing | installed | error
    "currentVersion": SERVER_VERSION,
    "latestVersion": "",
    "tagName": "",
    "releaseUrl": "",
    "releaseName": "",
    "releaseNotes": "",
    "checkedAt": 0,
    "stagedFiles": [],
    "error": "",
}

class UpdateLock:
    """更新任务锁：按当前事件循环惰性创建，避免跨事件循环复用报错"""

    def __init__(self) -> None:
        self._lock: asyncio.Lock | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    def _current(self) -> asyncio.Lock:
        loop = asyncio.get_running_loop()
        if self._lock is None or self._loop is not loop:
            self._lock, self._loop = asyncio.Lock(), loop
        return self._lock

    def locked(self) -> bool:
        """当前事件循环内是否有更新任务在跑"""
        return self._lock is not None and self._loop is asyncio.get_running_loop() and self._lock.locked()

    async def __aenter__(self) -> "UpdateLock":
        await self._current().acquire()
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        self._current().release()


# 同一时刻只允许一个检查 / 下载 / 安装任务
update_lock = UpdateLock()
# 下载取消标记（拉取每个文件前检查，关闭时置位）
update_cancel = threading.Event()


def set_update_status(**fields: Any) -> None:
    """更新状态字段（同时刷新 currentVersion）"""
    UPDATE_STATE.update(fields)
    UPDATE_STATE["currentVersion"] = SERVER_VERSION


def update_public_view() -> dict[str, Any]:
    """管理端看到的更新状态"""
    return {
        **{k: UPDATE_STATE[k] for k in UPDATE_STATE if k != "currentVersion"},
        "currentVersion": SERVER_VERSION,
        "updateAvailable": bool(
            UPDATE_STATE["latestVersion"]
            and version_is_newer(UPDATE_STATE["latestVersion"], SERVER_VERSION)
        ),
        "enabled": update_cfg_bool("enabled"),
        "githubRepo": update_cfg_str("github_repo"),
        "githubRepoConfigured": bool(update_cfg_str("github_repo")),
        "checkIntervalMinutes": update_cfg_int("check_interval_minutes", 60),
    }


def client_update_view() -> dict[str, Any]:
    """客户端看到的版本信息（只暴露版本号与“有待安装更新”这一事实）"""
    pending = UPDATE_STATE["status"] in ("ready", "installing") and bool(UPDATE_STATE["latestVersion"])
    return {
        "name": "splayer-together-server",
        "version": SERVER_VERSION,
        "updateAvailable": pending,
        "pendingVersion": UPDATE_STATE["latestVersion"] if pending else "",
    }


def save_update_state() -> None:
    """把已暂存待安装的更新信息写入 update-state.json，供重启后恢复"""
    if UPDATE_STATE["status"] != "ready" or not UPDATE_STATE["stagedFiles"]:
        return
    payload = {
        "latestVersion": UPDATE_STATE["latestVersion"],
        "tagName": UPDATE_STATE["tagName"],
        "stagedFiles": list(UPDATE_STATE["stagedFiles"]),
        "checkedAt": UPDATE_STATE["checkedAt"],
        "releaseUrl": UPDATE_STATE["releaseUrl"],
    }
    try:
        UPDATE_STATE_FILE.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    except OSError as exc:
        log.warning("写入 %s 失败：%s", UPDATE_STATE_FILE.name, exc)


def clear_update_state_file() -> None:
    try:
        UPDATE_STATE_FILE.unlink()
    except FileNotFoundError:
        pass
    except OSError as exc:
        log.warning("删除 %s 失败：%s", UPDATE_STATE_FILE.name, exc)


def staged_path(file_name: str) -> Path:
    """暂存目录内的文件路径（只允许已知文件名，拒绝路径穿越）"""
    if file_name not in UPDATE_FILES:
        raise UpdateError(f"未知的更新文件：{file_name}")
    return UPDATE_STAGING_DIR / file_name


def staged_files_complete() -> bool:
    """暂存目录中是否已有一整套更新文件"""
    return all(staged_path(name).is_file() for name in UPDATE_FILES)


def restore_update_state() -> None:
    """启动时读取 update-state.json：若暂存文件仍在且版本更新，则恢复为 ready"""
    if not UPDATE_STATE_FILE.exists():
        return
    try:
        data = json.loads(UPDATE_STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        log.warning("读取 %s 失败：%s", UPDATE_STATE_FILE.name, exc)
        return
    version = str(data.get("latestVersion", "") or "")
    staged = [str(n) for n in (data.get("stagedFiles") or []) if str(n) in UPDATE_FILES]
    if not version or not staged or not version_is_newer(version, SERVER_VERSION):
        clear_update_state_file()
        return
    UPDATE_STAGING_DIR.mkdir(exist_ok=True)
    missing = [n for n in staged if not staged_path(n).is_file()]
    if missing:
        log.warning("上次下载的更新文件缺失 %s，丢弃待安装状态", ", ".join(missing))
        clear_update_state_file()
        return
    set_update_status(
        status="ready",
        latestVersion=version,
        tagName=str(data.get("tagName", "") or f"v{version}"),
        releaseUrl=str(data.get("releaseUrl", "") or ""),
        stagedFiles=staged,
        checkedAt=int(data.get("checkedAt", 0) or 0),
        error="",
    )
    log.info("检测到上次下载但未安装的更新 %s，状态恢复为 ready", version)


def version_is_newer(candidate: str, current: str) -> bool:
    """比较版本号：candidate 是否比 current 新（非标准格式回退到字符串比较）"""
    a, b = parse_version(candidate), parse_version(current)
    if a is not None and b is not None:
        return a > b
    return str(candidate).lstrip("vV") > str(current).lstrip("vV")


def parse_version(version: str) -> tuple[int, ...] | None:
    """解析 ``1.2.3`` / ``v1.2.3`` / ``1.2.3-beta.1`` 为数字元组，失败返回 None"""
    text = str(version).strip().lstrip("vV").split("+")[0]
    core = text.split("-")[0]
    if not core:
        return None
    parts: list[int] = []
    for chunk in core.split("."):
        if not chunk.isdigit():
            return None
        parts.append(int(chunk))
    return tuple(parts)


# --------------------------------------------------------------------------
# 服务器自身更新：检查 / 下载 / 安装 / 重启
# --------------------------------------------------------------------------


def github_headers() -> dict[str, str]:
    """GitHub API 请求头（可选 token 提高限额并支持私有仓库）"""
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": f"splayer-together-server/{SERVER_VERSION}",
    }
    token = update_cfg_str("github_token")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def require_repo() -> str:
    """读取并校验 update.github_repo"""
    repo = update_cfg_str("github_repo")
    if not repo or "/" not in repo:
        raise UpdateError("未配置 update.github_repo（格式 owner/repo）")
    return repo.strip("/")


async def fetch_json(url: str) -> dict[str, Any]:
    """GET 并解析 JSON"""
    try:
        async with ClientSession(timeout=ClientTimeout(total=RELEASE_TIMEOUT_S)) as session:
            async with session.get(url, headers=github_headers()) as resp:
                if resp.status == 404:
                    raise UpdateError("仓库或最新版本不存在，请检查 update.github_repo")
                if resp.status == 403:
                    raise UpdateError("GitHub API 访问受限（403），可配置 update.github_token")
                if resp.status != 200:
                    raise UpdateError(f"请求 GitHub API 失败：HTTP {resp.status}")
                return await resp.json(content_type=None)
    except UpdateError:
        raise
    except Exception as exc:  # 网络 / 解析异常统一转成可展示消息
        raise UpdateError(f"访问 GitHub API 失败：{exc}") from exc


async def fetch_raw_text(path: str, tag: str) -> str:
    """从指定 tag 拉取仓库内的 raw 文本文件"""
    repo = require_repo()
    url = RAW_FILE_URL.format(repo=repo, tag=urllib.parse.quote(tag), file=urllib.parse.quote(path))
    try:
        async with ClientSession(timeout=ClientTimeout(total=RELEASE_TIMEOUT_S)) as session:
            async with session.get(url, headers=github_headers()) as resp:
                if resp.status != 200:
                    raise UpdateError(f"下载 {path} 失败：HTTP {resp.status}")
                return await resp.text()
    except UpdateError:
        raise
    except Exception as exc:
        raise UpdateError(f"下载 {path} 失败：{exc}") from exc


async def fetch_latest_release() -> dict[str, Any]:
    """查询 GitHub 最新 release，返回规范化后的版本信息"""
    repo = require_repo()
    data = await fetch_json(RELEASES_API_URL.format(repo=repo))
    tag = str(data.get("tag_name", "") or "").strip()
    if not tag:
        raise UpdateError("最新版本缺少 tag_name")
    release_version = tag.lstrip("vV")
    # 客户端 release 不一定包含服务器改动，必须读取 tag 内的 server.py 判断服务器版本。
    server_text = await fetch_raw_text("server.py", tag)
    match = SERVER_VERSION_RE.search(server_text)
    if match is None:
        raise UpdateError("release 中的 server.py 缺少 SERVER_VERSION 定义")
    server_version = match.group(1).lstrip("vV")
    return {
        "version": server_version,
        "releaseVersion": release_version,
        "tagName": tag,
        "releaseUrl": str(data.get("html_url", "") or RELEASE_PAGE_URL.format(repo=repo)),
        "releaseName": str(data.get("name", "") or tag),
        "releaseNotes": str(data.get("body", "") or ""),
    }


def validate_release_file(name: str, text: str, version: str) -> None:
    """校验下载到的文件：非空、语法可编译、依赖行可识别、版本与 release 一致"""
    if not text.strip():
        raise UpdateError(f"{name} 内容为空，已放弃更新")
    if name.endswith(".py"):
        try:
            compile(text, name, "exec")
        except SyntaxError as exc:
            raise UpdateError(f"{name} 语法校验失败：{exc}") from exc
        if name == "server.py":
            match = SERVER_VERSION_RE.search(text)
            if match is None:
                raise UpdateError("server.py 缺少 SERVER_VERSION 定义，已放弃更新")
            got = match.group(1).lstrip("vV")
            if got != version.lstrip("vV"):
                raise UpdateError(f"server.py 版本 {got} 与 release 版本 {version} 不一致")
    elif name == "requirements.txt":
        for line in text.splitlines():
            line = line.split("#", 1)[0].strip()
            if line and not REQUIREMENT_RE.match(line):
                raise UpdateError(f"requirements.txt 含无法识别的依赖行：{line}")


async def download_release_files(tag: str, version: str) -> list[str]:
    """把 UPDATE_FILES 全部拉到暂存目录并逐个校验，返回已暂存的文件名"""
    if update_cancel.is_set():
        raise UpdateError("服务器正在关闭，更新已取消")
    UPDATE_STAGING_DIR.mkdir(exist_ok=True)
    staged: list[str] = []
    for name in UPDATE_FILES:
        text = await fetch_raw_text(name, tag)
        validate_release_file(name, text, version)
        staged_path(name).write_text(text, encoding="utf-8")
        staged.append(name)
        log.debug("已下载并校验 %s（tag %s）", name, tag)
    return staged


def backup_current_files() -> Path:
    """把将被替换的文件备份到 backups/<当前版本>-<时间戳>/"""
    target = BACKUP_DIR / f"{SERVER_VERSION}-{time.strftime('%Y%m%d-%H%M%S')}"
    target.mkdir(parents=True, exist_ok=True)
    for name in UPDATE_FILES:
        src = BASE_DIR / name
        if src.is_file():
            shutil.copy2(src, target / name)
    return target


def install_staged_files(staged: list[str]) -> None:
    """把暂存文件移动到工作目录（同分区 rename，近似原子替换）"""
    for name in staged:
        shutil.move(str(staged_path(name)), str(BASE_DIR / name))


def spawn_restart_process() -> None:
    """用当前解释器与参数重新拉起服务器进程（脱离当前进程组）"""
    script = str(Path(sys.argv[0]).resolve()) if sys.argv and sys.argv[0] else str(BASE_DIR / "server.py")
    args = [sys.executable, script, *sys.argv[1:]]
    kwargs: dict[str, Any] = {"cwd": str(BASE_DIR), "stdin": subprocess.DEVNULL}
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS
    else:
        kwargs["start_new_session"] = True
    log.warning("重启服务器进程：%s", " ".join(args))
    subprocess.Popen(args, **kwargs)


def restart_process() -> None:
    """拉起新进程后立即退出旧进程（不调用 atexit，避免清理任务再次阻塞）"""
    update_cancel.set()
    try:
        spawn_restart_process()
    except OSError as exc:
        log.error("重启失败，请手动重启服务器：%s", exc)
        return
    os._exit(0)


def schedule_restart(delay_s: float = 1.0) -> None:
    """延迟重启：先让当前 HTTP 响应返回"""
    asyncio.get_running_loop().call_later(delay_s, restart_process)


async def check_for_update() -> dict[str, Any]:
    """检查 GitHub 最新 release 并刷新状态，返回管理端视图"""
    if update_lock.locked():
        raise UpdateError("已有更新任务正在进行，请稍后再试")
    async with update_lock:
        set_update_status(status="checking", error="")
        try:
            latest = await fetch_latest_release()
        except UpdateError as exc:
            set_update_status(status="error", error=str(exc))
            raise
        newer = version_is_newer(latest["version"], SERVER_VERSION)
        set_update_status(
            status="available" if newer else "up_to_date",
            latestVersion=latest["version"],
            tagName=latest["tagName"],
            releaseUrl=latest["releaseUrl"],
            releaseName=latest["releaseName"],
            releaseNotes=latest["releaseNotes"],
            checkedAt=now_ms(),
            error="",
        )
        if newer:
            log.info("发现新版本 %s（当前 %s）", latest["version"], SERVER_VERSION)
        else:
            log.info("检查完成：当前已是最新版本 %s", SERVER_VERSION)
    return update_public_view()


async def apply_update() -> dict[str, Any]:
    """下载（若尚未暂存）→ 校验 → 备份 → 替换，成功后安排重启"""
    if not update_cfg_bool("enabled"):
        raise UpdateError("服务器自更新未启用（config.yml 中 update.enabled: true）")
    if update_lock.locked():
        raise UpdateError("已有更新任务正在进行，请稍后再试")
    async with update_lock:
        try:
            version = str(UPDATE_STATE["latestVersion"] or "")
            tag = str(UPDATE_STATE["tagName"] or "")
            if not version or not tag:
                latest = await fetch_latest_release()
                version, tag = latest["version"], latest["tagName"]
                set_update_status(
                    latestVersion=version,
                    tagName=tag,
                    releaseUrl=latest["releaseUrl"],
                    releaseName=latest["releaseName"],
                    releaseNotes=latest["releaseNotes"],
                    checkedAt=now_ms(),
                )
            if not version_is_newer(version, SERVER_VERSION):
                raise UpdateError(f"当前已是最新版本（{SERVER_VERSION}），无需更新")
            if not staged_files_complete():
                set_update_status(status="downloading", stagedFiles=[], error="")
                staged = await download_release_files(tag, version)
            else:
                staged = list(UPDATE_FILES)
                log.info("复用已下载的更新文件（tag %s）", tag)
            set_update_status(status="ready", stagedFiles=staged)
            save_update_state()
            set_update_status(status="installing")
            backup = backup_current_files()
            install_staged_files(staged)
            clear_update_state_file()
            set_update_status(status="installed", stagedFiles=[], error="")
            log.warning(
                "已安装更新 %s → %s（备份于 %s），服务器即将重启",
                SERVER_VERSION,
                version,
                backup.relative_to(BASE_DIR).as_posix(),
            )
            schedule_restart()
        except UpdateError as exc:
            set_update_status(status="error", error=str(exc))
            raise
        except Exception as exc:  # 备份 / 写盘等意外错误
            set_update_status(status="error", error=f"更新失败：{exc}")
            raise UpdateError(f"更新失败：{exc}") from exc
    return update_public_view()


async def update_check_loop() -> None:
    """后台周期性检查最新版本（仅在 update.enabled 时启动）"""
    await asyncio.sleep(UPDATE_STARTUP_CHECK_DELAY_S)
    while True:
        try:
            await check_for_update()
        except asyncio.CancelledError:
            raise
        except UpdateError as exc:
            log.warning("自动检查更新失败：%s", exc)
        except Exception as exc:
            log.warning("自动检查更新异常：%s", exc)
        interval = max(1, update_cfg_int("check_interval_minutes", 60)) * 60
        await asyncio.sleep(interval)


async def start_update_checker(app: web.Application) -> None:
    """启动钩子：恢复待安装状态并按配置启动周期检查"""
    update_cancel.clear()
    restore_update_state()
    if not update_cfg_bool("enabled"):
        log.info("服务器自更新未启用（config.yml: update.enabled）")
        return
    if not update_cfg_str("github_repo"):
        log.warning("已启用自更新但未配置 update.github_repo，检查任务不会启动")
        return
    app["update_task"] = asyncio.create_task(update_check_loop())
    log.info(
        "自更新检查任务已启动（仓库 %s，间隔 %s 分钟）",
        update_cfg_str("github_repo"),
        update_cfg_int("check_interval_minutes", 60),
    )


async def stop_update_checker(app: web.Application) -> None:
    """关闭钩子：取消检查任务并置位下载取消标记"""
    update_cancel.set()
    task = app.get("update_task")
    if task is not None:
        task.cancel()
        log.info("自更新检查任务已停止")


class Room:
    """一个一起听房间"""

    def __init__(self, code: str, host_id: str):
        self.code = code
        self.host_id = host_id
        # member_id -> {"name", "token", "last_seen"}
        self.members: dict[str, dict[str, Any]] = {}
        self.state: dict[str, Any] | None = None
        self.queue: list[Any] = []
        self.reports: list[dict[str, Any]] = []
        self.seq = 0
        self.created_at = now_ms()
        self.host_last_push = now_ms()
        # 房主控制的成员权限（含 per-member 覆盖）
        self.permissions: dict[str, Any] = {
            "allowGuestControl": True,
            "allowGuestEditPlaylist": True,
            "members": {},
        }
        # 最后推播放状态的成员 id
        self.last_actor: str | None = None
        # 房间是否已关闭（解散/清理前三秒标记，让客户端 poll 到后优雅退出）
        self.closed = False
        self.closed_at = 0

    def touch(self, member_id: str) -> None:
        self.members[member_id]["last_seen"] = now_ms()

    def member_view(self) -> list[dict[str, Any]]:
        now = now_ms()
        return [
            {
                "id": mid,
                "name": m["name"],
                "role": "host" if mid == self.host_id else "guest",
            }
            for mid, m in self.members.items()
            if now - m["last_seen"] <= MEMBER_TIMEOUT_MS
        ]

    def online_count(self) -> int:
        now = now_ms()
        return sum(1 for m in self.members.values() if now - m["last_seen"] <= MEMBER_TIMEOUT_MS)

    def admin_view(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "hostId": self.host_id,
            "online": self.online_count(),
            "total": len(self.members),
            "state": self.state,
            "seq": self.seq,
        }


def room_snapshot(room: Room) -> dict[str, Any]:
    """生成房间快照：状态 / 成员 / 队列 / 报告（取出后清空报告）"""
    reports = room.reports
    room.reports = []
    return {
        "seq": room.seq,
        "state": room.state,
        "members": room.member_view(),
        "hostId": room.host_id,
        "queue": room.queue,
        "reports": reports,
        "permissions": room.permissions,
        "lastActor": room.last_actor,
        "serverNow": now_ms(),
        "closed": room.closed,
    }


def permission_for(room: Room, member_id: str, key: str) -> bool:
    """查询成员是否有某项权限，per-member 覆盖优先于全局默认"""
    members = room.permissions.get("members", {}) if isinstance(room.permissions, dict) else {}
    member = members.get(member_id, {}) if isinstance(members, dict) else {}
    if key in member:
        return bool(member[key])
    return bool(room.permissions.get(key, True))


def new_code() -> str:
    while True:
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(ROOM_CODE_LEN))
        if code not in rooms:
            return code


def admin_authed(request: web.Request) -> bool:
    """管理员认证：优先读 X-Admin-Token 请求头，其次读 spt_admin_token Cookie"""
    token = request.headers.get("X-Admin-Token", "") or request.cookies.get("spt_admin_token", "")
    return token in admin_tokens


def room_auth(request: web.Request) -> tuple[Room, str] | None:
    """校验成员凭据，返回 (room, member_id)"""
    code = request.match_info["code"].strip().upper()
    room = rooms.get(code)
    if room is None:
        return None
    member_id = request.headers.get("X-Member-Id", "")
    token = request.headers.get("X-Token", "")
    member = room.members.get(member_id)
    if member is None or member["token"] != token:
        return None
    return room, member_id


# --------------------------------------------------------------------------
# CORS
# --------------------------------------------------------------------------


@web.middleware
async def cors_middleware(request: web.Request, handler: Any) -> web.StreamResponse:
    if request.method == "OPTIONS":
        return web.Response(
            status=204,
            headers={
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token, X-Member-Id, X-Token",
            },
        )
    response = await handler(request)
    response.headers["Access-Control-Allow-Origin"] = "*"
    return response


# --------------------------------------------------------------------------
# 一起听房间（纯 HTTP）
# --------------------------------------------------------------------------


async def handle_create(request: web.Request) -> web.Response:
    body = await request.json()
    name = str(body.get("name", "")).strip() or "我"
    code = new_code()
    member_id = secrets.token_hex(16)
    token = secrets.token_hex(32)
    room = Room(code, member_id)
    room.members[member_id] = {"name": name, "token": token, "last_seen": now_ms()}
    rooms[code] = room
    log.info("创建房间 %s（房主 %s）", code, name)
    return web.json_response({"code": code, "memberId": member_id, "token": token})


async def handle_join(request: web.Request) -> web.Response:
    code = request.match_info["code"].strip().upper()
    room = rooms.get(code)
    if room is None:
        return web.json_response({"error": "room not found"}, status=404)
    body = await request.json()
    name = str(body.get("name", "")).strip() or "我"
    member_id = secrets.token_hex(16)
    token = secrets.token_hex(32)
    room.members[member_id] = {"name": name, "token": token, "last_seen": now_ms()}
    log.info("成员 %s 加入房间 %s（现有 %s 人）", name, code, len(room.members))
    return web.json_response({"memberId": member_id, "token": token})


async def handle_push_state(request: web.Request) -> web.Response:
    """成员推送播放状态（房主总是允许，获权成员也可推；baseSeq 乐观锁防覆盖）"""
    auth = room_auth(request)
    if auth is None:
        return web.json_response({"error": "unauthorized"}, status=401)
    room, member_id = auth
    body = await request.json()
    is_host = member_id == room.host_id
    if not is_host and not permission_for(room, member_id, "allowGuestControl"):
        return web.json_response({"error": "forbidden"}, status=403)
    # 乐观锁：客户端已知 seq 落后于当前（别人已推过）时拒绝覆盖，返回最新快照
    base_seq = int(body.get("baseSeq", 0) or 0)
    if base_seq > 0 and base_seq != room.seq and room.last_actor != member_id:
        return web.json_response({"conflict": True, "snapshot": room_snapshot(room)})
    room.seq += 1
    room.state = {
        "track": body.get("track"),
        "state": body.get("state"),
        "positionMs": int(body.get("positionMs", 0) or 0),
        "at": now_ms(),
        "playIndex": int(body.get("playIndex", -1) or -1),
        "repeatMode": str(body.get("repeatMode", "list")),
        "shuffleMode": str(body.get("shuffleMode", "off")),
    }
    room.last_actor = member_id
    if is_host:
        room.host_last_push = now_ms()
    room.touch(member_id)
    log.debug(
        "成员 %s 推送状态：%s，进度 %sms",
        member_id[:8],
        room.state.get("state"),
        room.state.get("positionMs"),
    )
    return web.json_response(room_snapshot(room))


async def handle_get_state(request: web.Request) -> web.Response:
    """成员拉取房间快照（状态 / 成员 / 队列 / 报告）"""
    auth = room_auth(request)
    if auth is None:
        return web.json_response({"error": "unauthorized"}, status=401)
    room, member_id = auth
    room.touch(member_id)
    return web.json_response(room_snapshot(room))


async def handle_push_queue(request: web.Request) -> web.Response:
    """成员推送播放列表（房主总是允许，获权成员也可推）"""
    auth = room_auth(request)
    if auth is None:
        return web.json_response({"error": "unauthorized"}, status=401)
    room, member_id = auth
    is_host = member_id == room.host_id
    if not is_host and not permission_for(room, member_id, "allowGuestEditPlaylist"):
        return web.json_response({"error": "forbidden"}, status=403)
    body = await request.json()
    room.queue = body.get("tracks", []) or []
    room.touch(member_id)
    log.debug(
        "成员 %s 推送播放列表（%s 首）到房间 %s",
        member_id[:8],
        len(room.queue),
        room.code,
    )
    return web.json_response(room_snapshot(room))


async def handle_set_permissions(request: web.Request) -> web.Response:
    """房主设置成员权限：不带 memberId 设置全局默认，带 memberId 设置单个成员覆盖"""
    auth = room_auth(request)
    if auth is None:
        return web.json_response({"error": "unauthorized"}, status=401)
    room, member_id = auth
    if member_id != room.host_id:
        return web.json_response({"error": "forbidden"}, status=403)
    body = await request.json()
    target = str(body.get("memberId", "") or "")
    current = room.permissions
    if target:
        # per-member 覆盖：字段缺省时清空该成员对应限制（恢复全局默认）
        members = current.get("members", {}) if isinstance(current, dict) else {}
        member_cfg = members.get(target, {}) if isinstance(members, dict) else {}
        updated = dict(member_cfg)
        if "allowGuestControl" in body:
            updated["allowGuestControl"] = bool(body.get("allowGuestControl"))
        if "allowGuestEditPlaylist" in body:
            updated["allowGuestEditPlaylist"] = bool(body.get("allowGuestEditPlaylist"))
        if updated:
            members[target] = updated
        else:
            members.pop(target, None)
        room.permissions = {**current, "members": members}
        log.info("房间 %s 成员 %s 权限更新：%s", room.code, target[:8], updated)
    else:
        room.permissions = {
            "allowGuestControl": bool(body.get("allowGuestControl", current.get("allowGuestControl", True))),
            "allowGuestEditPlaylist": bool(
                body.get("allowGuestEditPlaylist", current.get("allowGuestEditPlaylist", True))
            ),
            "members": current.get("members", {}) if isinstance(current, dict) else {},
        }
        log.info("房间 %s 权限更新：%s", room.code, room.permissions)
    room.touch(member_id)
    return web.json_response(room_snapshot(room))


async def handle_transfer_host(request: web.Request) -> web.Response:
    """房主将房主身份转移给其他成员，自己变为成员"""
    auth = room_auth(request)
    if auth is None:
        return web.json_response({"error": "unauthorized"}, status=401)
    room, member_id = auth
    if member_id != room.host_id:
        return web.json_response({"error": "forbidden"}, status=403)
    body = await request.json()
    target = str(body.get("targetMemberId", ""))
    if target not in room.members or target == member_id:
        return web.json_response({"error": "invalid target"}, status=400)
    room.host_id = target
    room.host_last_push = now_ms()
    room.touch(member_id)
    log.warning("房主 %s 将房主身份转移给 %s（房间 %s）", member_id[:8], target[:8], room.code)
    return web.json_response(room_snapshot(room))


async def handle_report(request: web.Request) -> web.Response:
    """成员上报无法播放，供房主快照时取走"""
    auth = room_auth(request)
    if auth is None:
        return web.json_response({"error": "unauthorized"}, status=401)
    room, member_id = auth
    room.touch(member_id)
    body = await request.json()
    member_name = room.members.get(member_id, {}).get("name", "成员")
    track_title = str(body.get("trackTitle", ""))
    room.reports.append(
        {
            "kind": str(body.get("kind", "")),
            "name": member_name,
            "trackTitle": track_title,
        }
    )
    log.info("成员 %s 上报无法播放《%s》（房间 %s）", member_name, track_title, room.code)
    return web.json_response({"ok": True})


async def handle_leave(request: web.Request) -> web.Response:
    auth = room_auth(request)
    if auth is None:
        return web.json_response({"error": "unauthorized"}, status=401)
    room, member_id = auth
    room.members.pop(member_id, None)
    if member_id == room.host_id:
        now = now_ms()
        for mid, m in room.members.items():
            if now - m["last_seen"] <= MEMBER_TIMEOUT_MS:
                room.host_id = mid
                room.host_last_push = now
                log.warning("房主离开房间 %s，房主转移给 %s", room.code, mid)
                break
        else:
            room.closed = True
            room.closed_at = now_ms()
            log.info("房主离开，房间 %s 即将解散", room.code)
            return web.json_response(room_snapshot(room))
    log.info("成员离开房间 %s（在线 %s 人）", room.code, room.online_count())
    return web.json_response({"ok": True})


# --------------------------------------------------------------------------
# 后台清理：房主失联转移 / 僵尸房间回收
# --------------------------------------------------------------------------


async def cleanup_loop() -> None:
    while True:
        await asyncio.sleep(CLEANUP_INTERVAL_MS / 1000)
        now = now_ms()
        for code, room in list(rooms.items()):
            # 已标记关闭的房间，3 秒后删除
            if room.closed and room.closed_at > 0 and now - room.closed_at > 3_000:
                rooms.pop(code, None)
                log.info("清理已关闭房间 %s", code)
                continue
            # 房主超过 MEMBER_TIMEOUT_MS 未在线时转移房主
            host_member = room.members.get(room.host_id)
            if host_member and now - host_member["last_seen"] > MEMBER_TIMEOUT_MS:
                for mid, m in room.members.items():
                    if mid != room.host_id and now - m["last_seen"] <= MEMBER_TIMEOUT_MS:
                        room.host_id = mid
                        room.host_last_push = now
                        log.warning(
                            "房主失联（%s 秒未在线），房间 %s 房主转移给 %s",
                            MEMBER_TIMEOUT_MS // 1000,
                            room.code,
                            mid,
                        )
                        break
            if room.online_count() == 0 and now - room.created_at > ROOM_TTL_MS:
                rooms.pop(code, None)
                log.info("清理空闲房间 %s（创建超过 %s 分钟）", room.code, ROOM_TTL_MS // 60000)


async def start_cleanup(app: web.Application) -> None:
    app["cleanup_task"] = asyncio.create_task(cleanup_loop())
    log.info("后台清理任务已启动（间隔 %s 秒）", CLEANUP_INTERVAL_MS // 1000)


async def stop_cleanup(app: web.Application) -> None:
    task = app.get("cleanup_task")
    if task is not None:
        task.cancel()
        log.info("后台清理任务已停止")


# --------------------------------------------------------------------------
# WebUI 管理后台
# --------------------------------------------------------------------------


async def handle_admin_login(request: web.Request) -> web.Response:
    body = await request.json()
    username = str(body.get("username", ""))
    password = str(body.get("password", ""))
    if username == ADMIN_USERNAME and password == ADMIN_PASSWORD:
        token = secrets.token_hex(32)
        admin_tokens.add(token)
        log.info("管理员登录成功：%s", username)
        resp = web.json_response({"token": token})
        # 设置 cookie（24h 过期），httponly 防止 JS 读取，WebUI 同源请求自动携带
        resp.set_cookie(
            "spt_admin_token", token,
            max_age=86400, httponly=True, samesite="lax", path="/",
        )
        return resp
    log.warning("管理员登录失败：%s", username)
    return web.json_response({"error": "invalid credentials"}, status=401)


async def handle_admin_logout(request: web.Request) -> web.Response:
    token = request.headers.get("X-Admin-Token", "") or request.cookies.get("spt_admin_token", "")
    admin_tokens.discard(token)
    resp = web.json_response({"ok": True})
    resp.del_cookie("spt_admin_token", path="/")
    return resp


async def handle_admin_reload(request: web.Request) -> web.Response:
    """重新加载 config.yml，无需重启服务器"""
    if not admin_authed(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    global CONFIG, ADMIN_USERNAME, ADMIN_PASSWORD
    config = load_config()
    CONFIG = config
    ADMIN_USERNAME = str(config["admin"]["username"])
    ADMIN_PASSWORD = str(config["admin"]["password"])
    log.info("管理员刷新配置")
    return web.json_response({"ok": True})


async def handle_admin_rooms_list(request: web.Request) -> web.Response:
    if not admin_authed(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    # 过滤已关闭的房间，已解散的房间在 WebUI 中立即消失（client 端仍能收到 closed 通知）
    return web.json_response({"rooms": [r.admin_view() for r in rooms.values() if not r.closed]})


async def handle_admin_room_dissolve(request: web.Request) -> web.Response:
    if not admin_authed(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    code = request.match_info["code"].strip().upper()
    if code not in rooms:
        return web.json_response({"error": "room not found"}, status=404)
    room = rooms[code]
    room.closed = True
    room.closed_at = now_ms()
    log.warning("管理员解散房间 %s", code)
    return web.json_response({"ok": True})


async def handle_admin_page(request: web.Request) -> web.StreamResponse:
    return web.Response(text=render_admin_page(), content_type="text/html")


# --------------------------------------------------------------------------
# 服务器自身更新：HTTP 接口
# --------------------------------------------------------------------------


async def handle_version(request: web.Request) -> web.Response:
    """公开版本信息（客户端据此提示有新版本待安装）"""
    return web.json_response(client_update_view())


async def handle_admin_update_status(request: web.Request) -> web.Response:
    """查看当前更新状态"""
    if not admin_authed(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    return web.json_response(update_public_view())


async def handle_admin_update_check(request: web.Request) -> web.Response:
    """立即检查一次 GitHub 最新版本"""
    if not admin_authed(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    try:
        view = await check_for_update()
    except UpdateError as exc:
        return web.json_response({"error": str(exc)}, status=400)
    return web.json_response(view)


async def handle_admin_update_apply(request: web.Request) -> web.Response:
    """下载并安装最新版本（校验通过后备份替换，随后自动重启）"""
    if not admin_authed(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    try:
        view = await apply_update()
    except UpdateError as exc:
        return web.json_response({"error": str(exc)}, status=400)
    log.warning("管理员触发服务器自更新：%s", view["latestVersion"])
    return web.json_response(view)


async def handle_admin_update_restart(request: web.Request) -> web.Response:
    """立即重启服务器（先返回响应，再拉起新进程）"""
    if not admin_authed(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    log.warning("管理员触发服务器重启")
    schedule_restart()
    return web.json_response({"ok": True, "message": "服务器将在 1 秒后重启"})


async def handle_admin_update_changelog(request: web.Request) -> web.Response:
    """查看某版本的更新日志：优先本地 changelogs/<version>.md，其次从仓库拉取"""
    if not admin_authed(request):
        return web.json_response({"error": "unauthorized"}, status=401)
    version = request.query.get("version", "").strip() or str(
        UPDATE_STATE["latestVersion"] or SERVER_VERSION
    )
    if not VERSION_RE.match(version):
        return web.json_response({"error": "版本号格式不正确"}, status=400)
    local = CHANGELOGS_DIR / f"{version}.md"
    if local.is_file():
        return web.json_response(
            {
                "version": version,
                "source": "local",
                "markdown": local.read_text(encoding="utf-8"),
            }
        )
    tag = str(UPDATE_STATE["tagName"] or "") or f"v{version}"
    try:
        text = await fetch_raw_text(f"changelogs/{version}.md", tag)
    except UpdateError:
        return web.json_response({"error": f"未找到 {version} 的更新日志"}, status=404)
    return web.json_response({"version": version, "source": "github", "markdown": text})


async def index(_request: web.Request) -> web.Response:
    return web.Response(text="SPlayer Together relay server")


def build_app() -> web.Application:
    app = web.Application(middlewares=[cors_middleware])
    app.router.add_get("/", index)
    app.router.add_get("/admin", handle_admin_page)
    app.router.add_static("/downloads", DOWNLOADS_DIR, show_index=True)
    app.router.add_get("/api/version", handle_version)
    app.router.add_post("/api/rooms", handle_create)
    app.router.add_post("/api/rooms/{code}/join", handle_join)
    app.router.add_post("/api/rooms/{code}/state", handle_push_state)
    app.router.add_get("/api/rooms/{code}/state", handle_get_state)
    app.router.add_post("/api/rooms/{code}/queue", handle_push_queue)
    app.router.add_post("/api/rooms/{code}/permissions", handle_set_permissions)
    app.router.add_post("/api/rooms/{code}/transfer", handle_transfer_host)
    app.router.add_post("/api/rooms/{code}/report", handle_report)
    app.router.add_post("/api/rooms/{code}/leave", handle_leave)
    app.router.add_post("/api/admin/login", handle_admin_login)
    app.router.add_post("/api/admin/logout", handle_admin_logout)
    app.router.add_post("/api/admin/reload", handle_admin_reload)
    app.router.add_get("/api/admin/rooms", handle_admin_rooms_list)
    app.router.add_post("/api/admin/rooms/{code}/dissolve", handle_admin_room_dissolve)
    app.router.add_get("/api/admin/update/status", handle_admin_update_status)
    app.router.add_post("/api/admin/update/check", handle_admin_update_check)
    app.router.add_post("/api/admin/update/apply", handle_admin_update_apply)
    app.router.add_post("/api/admin/update/restart", handle_admin_update_restart)
    app.router.add_get("/api/admin/update/changelog", handle_admin_update_changelog)
    app.on_startup.append(start_cleanup)
    app.on_cleanup.append(stop_cleanup)
    app.on_startup.append(start_update_checker)
    app.on_cleanup.append(stop_update_checker)
    return app


def main() -> None:
    if ADMIN_PASSWORD == "change-me":
        log.warning("管理后台仍在使用默认密码，请尽快在 config.yml 中修改")
    host = str(CONFIG["host"])
    port = int(CONFIG["port"])
    log.info(
        "SPlayer Together 中继服务器启动 v%s：http://%s:%s（管理后台 /admin）",
        SERVER_VERSION,
        host,
        port,
    )
    web.run_app(build_app(), host=host, port=port, access_log=None)


if __name__ == "__main__":
    main()
