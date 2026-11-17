# 迭代流程

## 分支与版本

- `main` 保持可发布；功能分支使用 `feature/<short-name>`，修复分支使用 `fix/<short-name>`。
- 使用语义化版本：兼容性功能升级次版本，修复升级补丁版本，破坏接口或数据迁移升级主版本。
- 每个发布版本必须更新 `package.json`、`CHANGELOG.md` 和必要的部署说明。

## 开发闭环

1. 从最新 `main` 创建分支。
2. 先补复现测试，再修改实现；涉及 HTTP 合同、凭据或 Credits 时必须覆盖失败路径。
3. 本地执行 `npm test`。界面改动再执行浏览器 smoke，并分别检查桌面和手机宽度。
4. 检查 `git diff`，确认 `.env`、`runtime/`、数据库、日志和课程原始资料没有进入提交。
5. 推送分支并创建 Pull Request，等待 Windows/Linux 测试和 Docker 构建通过。

## 发布

```powershell
git switch main
git pull --ff-only
npm test
git tag -a v1.1.0 -m "FDEX Image Service v1.1.0"
git push origin main
git push origin v1.1.0
```

Release 说明应列出功能变化、配置变化、数据库兼容性、验收步骤和已知限制。生产升级前备份数据 Volume，升级后检查 `/api/health`、管理员登录、Mock 生成和历史图稿读取。

## 数据变更

当前版本使用 SQLite 的 `CREATE TABLE IF NOT EXISTS` 做轻量初始化，没有自动迁移框架。新增字段或修改约束时：

- 在发布前提供可重复执行的迁移脚本。
- 先在数据库副本上验证升级和回滚。
- 明确新版本能否读取旧数据库，以及旧版本能否读取迁移后的数据库。
- 不通过删除数据库来解决升级问题。

## 故障回滚

1. 停止写入并保留日志。
2. 备份当前数据 Volume。
3. 切回上一稳定镜像标签。
4. 若数据格式不兼容，用升级前备份恢复，不要手工拼接 SQLite 与 WAL 文件。
5. 执行健康检查、管理员登录、历史图稿读取和一次 Mock 生成。
