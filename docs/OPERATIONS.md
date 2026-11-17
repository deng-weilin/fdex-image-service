# 部署与运维

## 开发环境

`APP_ENV=development` 适合本机课堂演示。它允许演示账户和自主注册，并使用 Mock 输出。

## 生产环境

推荐使用 `compose.yaml` 启动容器。`Dockerfile` 以非 root 的 `node` 用户运行，`compose.yaml` 将端口绑定到本机并把 `runtime/` 映射到 `fdex-runtime` Volume。生产变量模板见 `.env.production.example`。

```bash
cp .env.production.example .env.production
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 image-service
```

生产环境至少配置以下变量：

```dotenv
APP_ENV=production
HOST=127.0.0.1
PORT=4310
APP_ORIGIN=https://images.example.com
SEED_DEMO_ACCOUNTS=false
ALLOW_REGISTRATION=false
INITIAL_CREDITS=0
COOKIE_SECURE=true
TRUST_PROXY=true
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-with-a-unique-password
IMAGE_PROVIDER=live
IMAGE_API_BASE_URL=https://api.openai.com/v1
IMAGE_API_STYLE=openai
IMAGE_API_KEY=replace-with-your-key
IMAGE_GENERATE_MODEL=gpt-image-1
IMAGE_EDIT_MODEL=gpt-image-1
```

生产模式会拒绝 HTTP Origin、演示账户和不足 12 个字符的 `ADMIN_PASSWORD`。首个管理员只在数据库中不存在该账号时创建；部署完成后应从运行环境移除 `ADMIN_PASSWORD`，避免长期保留明文引导密码。

管理员可在网页创建成员与重置密码，成员可自行改密。任何密码变更都会撤销目标账户的全部会话和 WorkBuddy Token，这是交付时的预期安全行为。

## 反向代理

建议让 Node.js 只监听 `127.0.0.1`，由 Caddy、Nginx 或云负载均衡终止 TLS。外部地址必须与 `APP_ORIGIN` 完全一致。

只有在请求一定经过受信任代理时才能设置 `TRUST_PROXY=true`。否则客户端可以伪造 `X-Forwarded-For`，绕过认证限流。代理还应设置合理的请求体上限、连接超时和基础访问日志。

## 数据目录

默认数据位于 `runtime/`：

```text
runtime/image-service.sqlite
runtime/uploads/
runtime/outputs/
```

`DATA_DIR` 必须位于持久化磁盘，并限制为服务运行账户可读写。不要在 Web 根目录直接暴露 `runtime/`。

## 备份

SQLite 使用 WAL 模式。最稳妥的轻量备份流程是先停止服务，再复制整个 `runtime/`；这能同时保证数据库、上传资料和输出图稿一致。

若必须在线备份，应使用 SQLite backup API 或 `VACUUM INTO` 生成数据库快照，并另外复制 `uploads/` 与 `outputs/`。只复制主数据库而遗漏 WAL 文件可能得到不完整备份。

定期验证备份能否恢复，并至少覆盖以下流程：

1. 启动服务。
2. 登录管理员账户。
3. 查看成员、余额和任务。
4. 打开一张历史图稿。
5. 在 Mock 模式提交一次不产生供应商费用的测试任务。

## 密钥轮换

Provider API Key 和 MCP Token 都是敏感凭证。发生以下情况时立即轮换：

- 出现在截屏、录屏、聊天记录或提交历史中。
- 运行账户、反向代理或备份存储被非授权访问。
- 维护人员离职或权限发生变化。

网页中的 Provider Key 只显示末四位，MCP Token 只在创建时显示一次。轮换后检查健康接口中的 Provider readiness，并用 Mock 或低成本的专用测试账户验证鉴权链。

## 资源与限制

- 单个 Node.js 进程和 SQLite 数据库，不支持多实例并发写入自动协调。
- Provider 同步请求可能持续数十秒，反向代理超时应大于 `IMAGE_API_TIMEOUT_MS`。
- Windows 本地中文排版依赖 PowerShell、`System.Drawing` 和中文字体。
- Linux 不执行本地文字层；需要跨平台确定性排版时应增加独立的跨平台渲染依赖。
