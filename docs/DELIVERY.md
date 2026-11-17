# 交付清单

这份清单用于把服务交给客户或项目接手人。开发验收和生产上线分开执行，避免第一次真实调用产生不可控费用。

## 交付物

- GitHub 源码仓库和对应版本标签。
- `.env.production.example`、`Dockerfile`、`compose.yaml`。
- 自动化测试报告和 GitHub Actions 结果。
- 本清单、[部署与运维](OPERATIONS.md)和[迭代流程](ITERATION.md)。
- WorkBuddy MCP 配置与 `workbuddy/SKILL.md`。
- 数据备份位置、管理员移交方式和供应商账号责任人。

## 生产部署

1. 准备一台安装 Docker Compose 的 Linux 主机，并配置 HTTPS 域名。
2. 复制 `.env.production.example` 为 `.env.production`，替换 `APP_ORIGIN` 和唯一的 `ADMIN_PASSWORD`。
3. 首次上线先保留 `IMAGE_PROVIDER=mock`，运行 `docker compose up -d --build`。
4. 在反向代理中把 HTTPS 流量转到 `127.0.0.1:4310`，代理请求体上限应大于 13 MB。
5. 访问 `/api/health`，确认 `ok=true`、`providerReady=true`。
6. 用管理员登录，创建客户成员账户，并按交付约定设置初始 Credits。
7. 完成 Mock 验收后，再由管理员在“系统设置”切换真实 Provider，或修改环境变量后重建容器。

`compose.yaml` 默认只把端口绑定到本机，避免 Node.js 直接暴露公网。反向代理必须终止 TLS，`APP_ORIGIN` 必须与实际 HTTPS 地址一致。只有请求一定经过受信任代理时才设置 `TRUST_PROXY=true`。

## 验收

Mock 验收不产生供应商费用：

- 管理员登录、创建成员、重置成员密码。
- 新成员登录、修改自己的密码，确认旧会话和旧 Token 已失效。
- 上传或载入资料，保存 `DrawingSpec` 并完成一次生成。
- 基于已有图稿完成一次编辑，原版本仍可访问。
- 管理员发放 Credits，成员账本出现对应流水。
- 成员创建 WorkBuddy Token，MCP 可以读取余额和图稿。
- 桌面宽度与手机宽度均可完成登录和主要操作。

真实 Provider 验收至少执行一次新生成和一次编辑，并人工检查：

- 图片可预览、下载，任务终态和 Credits 流水一致。
- 图中尺寸、文字和安装说明没有超出资料依据。
- 失败时预留 Credits 正确释放；结果未知时不会自动重复付费提交。

## 数据与回滚

- 持久数据位于 Docker Volume `fdex-runtime`，包含 SQLite、上传资料和输出图稿。
- 版本升级前先停止服务并备份整个 Volume；不要只复制 SQLite 主文件而遗漏 WAL 文件。
- 回滚镜像时使用上一版本标签，保留原数据 Volume。涉及数据库结构变更时，必须先阅读对应版本的发布说明。
- Provider Key、管理员密码和备份文件不进入 GitHub；发生泄露时立即轮换。

## 移交确认

- [ ] GitHub 仓库、Release 标签和部署版本一致。
- [ ] 生产账号、域名、TLS 证书和续期责任明确。
- [ ] 首位管理员密码已由接手方设置，不使用模板密码。
- [ ] Provider 账号、额度、账单责任人和 Key 轮换方式明确。
- [ ] 数据备份任务、保留周期和恢复演练负责人明确。
- [ ] WorkBuddy 接入人完成一次真实 MCP 调用。
- [ ] 已知限制和人工复核要求已书面确认。
