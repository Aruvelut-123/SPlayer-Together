# SPlayer Together 中继服务器

一起听与授权认证共用的中继服务器，用 Python + aiohttp 编写，自带 WebUI 管理后台。
一起听同步全部走**纯 HTTP 轮询**（房主推送、成员拉取），不使用 WebSocket，部署简单且不易断线。

## 运行

```bash
pip install -r requirements.txt
python server.py
```

首次运行前，从示例复制一份配置文件：

```bash
cp config.example.yml config.yml
```

默认监听 `0.0.0.0:8000`。

## 日志

服务器使用 Python 标准库 `logging` 输出到标准输出（适合 Docker 用 `docker logs` 查看），
格式为 `时间 [级别] 模块: 消息`。可用环境变量 `LOG_LEVEL` 调整级别
（`DEBUG` / `INFO` / `WARNING` / `ERROR`，默认 `INFO`）。

- `INFO`：房间创建 / 加入 / 离开 / 解散、密钥增删、管理员登录等关键事件
- `DEBUG`：房主状态与队列推送等高频动作（默认关闭，避免刷屏）
- `WARNING`：房主失联转移、管理员解散房间、仍在使用默认密码等

## 配置（config.yml）

```yaml
host: 0.0.0.0
port: 8000
admin:
  username: admin      # WebUI 登录用户名
  password: change-me  # WebUI 登录密码，务必修改
keys: []               # 机器授权密钥白名单
```

> `config.yml` 已被 `.gitignore` 忽略，不会提交到仓库，避免泄露管理员凭据与密钥。

## WebUI 管理后台

启动后访问 `http://<服务器>:8000/admin`，用 `config.yml` 中的管理员账号登录，可：

- 查看 / 添加 / 删除机器授权密钥
- 查看进行中的房间并一键解散

WebUI 与所有管理接口都需要管理员登录（session token）后才能使用。

## 授权流程

1. 客户端按机器 ID 生成形如 `XXXX-XXXX-XXXX-XXXX` 的密钥，展示在软件解锁界面。
2. 用户把密钥发给管理员，管理员在 WebUI（或 `config.yml`）中加入白名单。
3. 客户端每 5 分钟（含启动时）调用 `POST /api/auth` 复核，命中白名单才能继续使用软件。

## 接口

一起听房间操作（创建 / 加入除外）需携带成员请求头：
`X-Auth-Key`（机器密钥）+ `X-Member-Id` + `X-Token`。

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| POST | `/api/auth` | 机器授权校验，body `{"key": "..."}` |
| POST | `/api/rooms` | 创建一起听房间（房主），需 `X-Auth-Key` |
| POST | `/api/rooms/{code}/join` | 加入房间，需 `X-Auth-Key` |
| POST | `/api/rooms/{code}/state` | 房主推送播放状态，返回房间快照 |
| GET | `/api/rooms/{code}/state` | 成员拉取房间快照（状态 / 成员 / 队列 / 报告） |
| POST | `/api/rooms/{code}/queue` | 房主推送播放列表 |
| POST | `/api/rooms/{code}/report` | 成员上报无法播放，房主下次拉取时收到 |
| POST | `/api/rooms/{code}/leave` | 离开房间（房主离开自动转移房主） |
| POST | `/api/admin/login` | 管理员登录，返回 token |
| GET/POST | `/api/admin/keys` | 查询 / 添加密钥，需 `X-Admin-Token` |
| DELETE | `/api/admin/keys/{key}` | 删除密钥，需 `X-Admin-Token` |
| GET | `/api/admin/rooms` | 房间列表，需 `X-Admin-Token` |
| POST | `/api/admin/rooms/{code}/dissolve` | 解散房间，需 `X-Admin-Token` |
| GET | `/api/update` | 客户端更新检查，返回 `{version, url, notes, size}` |

## 发布新版本（更新检查与授权服务器合并）

客户端每次检查更新时请求 `GET /api/update`。发布新版本步骤：

1. 把安装包（如 `SPlayer Together-1.0.2-x64-setup.exe`）放进 `server/downloads/` 目录。
2. 编辑 `server/config.yml` 的 `update` 段：

   ```yaml
   update:
     version: 1.0.2   # 必须大于客户端当前版本才会提示更新
     url: http://47.122.127.107:8000/downloads/SPlayer%20Together-1.0.2-x64-setup.exe
     notes: |         # 更新日志（changelog），| 表示多行文本
       1.0.2
       - 修复房主切歌后成员未同步到同一首歌的问题
       - 修复弹出列表按钮点击穿透问题
     size: 102760448  # 安装包字节数（可选，用于显示大小）
   ```

   > 安装包文件名含空格时，`url` 里要把空格写成 `%20`（如 `SPlayer%20Together-...`）。

3. 重启服务器即可生效。客户端每 6 小时自动检查（也可手动检查），发现新版本后主进程
   直接从 `url` 下载安装包，下载完成提示用户安装。

## 房间生命周期

- 房主每 2 秒推送一次状态，成员每 2 秒拉取一次快照（含漂移纠正）。
- 房主超过 20 秒未推送视为失联，服务器自动把房主转移给在线成员。
- 无在线成员且创建超过 10 分钟的房间由后台任务自动清理，不留僵尸房间。
