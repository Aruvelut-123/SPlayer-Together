# SPlayer Together 中继服务器

一起听与授权认证共用的中继服务器，用 Python + aiohttp 编写，自带 WebUI 管理后台。

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

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| POST | `/api/auth` | 机器授权校验，body `{"key": "..."}` |
| POST | `/api/rooms` | 创建一起听房间，需 `X-Auth-Key` |
| POST | `/api/rooms/{code}/join` | 加入房间，需 `X-Auth-Key` |
| GET | `/api/rooms/{code}/ws` | 房间 WebSocket，需 `?key=` |
| POST | `/api/admin/login` | 管理员登录，返回 token |
| GET/POST | `/api/admin/keys` | 查询 / 添加密钥，需 `X-Admin-Token` |
| DELETE | `/api/admin/keys/{key}` | 删除密钥，需 `X-Admin-Token` |
| GET | `/api/admin/rooms` | 房间列表，需 `X-Admin-Token` |
| POST | `/api/admin/rooms/{code}/dissolve` | 解散房间，需 `X-Admin-Token` |
