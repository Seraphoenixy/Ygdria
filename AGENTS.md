# Ygdria 项目记忆（权威）

本文件是项目级 Agent 记忆的唯一权威来源，只记录稳定、明确且已由代码、文档或验证结果支持的事实与规则。临时结论、任务上下文、一次性运行结果和推测先写入 [`.agent/memory/`](.agent/memory/)，不得直接追加到这里；候选事实经过交叉验证并确认具有长期价值后，才可提升到本文件。若记忆与当前代码或文档冲突，应先停止假设、核对实现并更新记忆。

## 项目定位与运行

- Ygdria 是单用户、自托管、本地优先的个人知识库；它不是多人实时协作系统，也不使用 CRDT。
- 工作区由 `apps/*` 与 `packages/*` 组成，使用 Node.js 24.x、Corepack + pnpm 10；TypeScript 采用严格模式和 ES Modules。
- 正常运行时由一个 Fastify 进程同时提供 React SPA、REST API 和 ETAPI，默认监听 `127.0.0.1:4318`。Vite 仅用于开发热更新并代理 `/api`、`/etapi`，不替代服务端。

## 架构与模块边界

依赖方向必须保持为：`Adapter → Domain → Database`，`Editor` 与 `Shared` 为跨层支撑。HTTP 路由、Electron IPC 和 React 组件不承载核心业务规则；领域规则放在 `packages/domain`，以便桌面本地服务、独立服务和未来导入器复用。

- `apps/server`：Fastify 适配器、静态资源托管、认证 hook、同步端点和维护调度。
- `apps/web`：React 工作区、TanStack Query/Zustand 状态、编辑器界面、客户端加密会话和桌面远端代理客户端。
- `apps/desktop`：Electron 主进程、本地 Fastify、远端 IPC 代理、`safeStorage` 凭据存储及 SSRF/路径白名单防护。
- `apps/mobile`：Capacitor 壳，复用 `apps/web` 的 SPA 和移动端原生集成。
- `packages/domain`：笔记、树/clone、保存、搜索、附件、关系、回收站和受保护笔记等领域服务；`Devices` 是不依赖数据库的纯内存认证服务。
- `packages/database`：SQLite（WAL + FTS5）、Drizzle、幂等迁移、备份恢复、doctor 及同步日志/游标/墓碑。
- `packages/editor`：Tiptap/ProseMirror 编辑与渲染、Markdown 转换、代码高亮及正文查找替换。
- `packages/shared`、`packages/api-client`：跨端 Zod 契约/常量与 HTTP/SRP 客户端封装。

## 必须保持的设计约束

- 正文权威格式是 Tiptap JSON；Markdown 是导入、导出、源码视图和 ETAPI 的交换格式，不应重新引入独立的 Markdown 权威缓存。
- 正文保存使用乐观并发（`expectedVersion`/`If-Match`），正文、修订和 FTS 投影应在同一 SQLite 事务内保持一致。受保护笔记由客户端加密，服务端仅处理密文，不进入 FTS 和普通修订路径。
- 多端同步基于 `sync_change_log`、`sync_cursors`、`sync_tombstones` 的游标增量机制，并用墓碑防止旧数据复活；不要把它实现成 CRDT 或多人实时协作。
- 独立服务的远端访问必须经 HTTPS 反向代理；桌面渲染进程不直接请求远端，也不得持有明文 `deviceToken`，远端调用由 Electron 主进程完成。
- TanStack Query 只管理服务端数据和请求状态；Zustand 只管理本地 UI 状态；Tiptap 的实时 ProseMirror 文档留在编辑器内部。

## 开发命令与编码规范

统一使用 `corepack pnpm`，常用命令如下：

```powershell
corepack pnpm install
corepack pnpm --filter @ygdria/database migrate
corepack pnpm dev:server       # 正常单端口运行
corepack pnpm dev              # Vite 热更新；另需 dev:server
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm lint             # i18n 硬编码检查
corepack pnpm check-search-index
corepack pnpm rebuild-search-index
corepack pnpm ygdria doctor
```

- 格式化遵循根目录 `.prettierrc.json`：2 空格、分号、双引号、尾随逗号、100 列。
- UI 文案必须接入现有 i18n 系统；`corepack pnpm lint` 是提交前的硬编码检查。
- 主题令牌的唯一来源是 `apps/web/src/styles/foundation/tokens.css`；不要重新引入 Tailwind 或绕过令牌系统写主题色。
- 修改数据库模型、正文编解码、同步边界或认证协议时，必须同时检查对应迁移、领域/适配器代码、测试和 `docs/` 说明。

## 详细资料入口

架构见 [`docs/architecture.md`](docs/architecture.md)，认证与同步边界见 [`docs/auth-and-sync.md`](docs/auth-and-sync.md)，数据模型见 [`docs/data-model.md`](docs/data-model.md)，运维命令见 [`docs/operations.md`](docs/operations.md)；API 与 ETAPI 细节见 `docs/api.md`、`docs/etapi.md` 和 `docs/etapi-ai.md`。
