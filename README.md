# Ygdria

Ygdria 是一个单用户、自托管的个人知识库：以树形笔记、可克隆位置、Tiptap JSON 正文和可迁移 Markdown 为核心。生产模式由同一个 Fastify 进程在一个端口提供 Web 界面与 API。多端同步采用基于游标的增量变更日志，桌面端远端访问由 Electron 主进程代理（渲染进程不持有设备令牌）。

运行环境统一使用 Node.js 24 LTS（24.x）；建议使用 nvm/nvm-windows 等版本管理工具自动读取仓库根目录的 `.nvmrc`。

## 快速开始

```powershell
# 安装工作区依赖
corepack pnpm install

# 创建或升级 SQLite 数据库
corepack pnpm --filter @ygdria/database migrate

# 构建 Web 界面，使 Fastify 可在同一端口托管它
corepack pnpm --filter @ygdria/web build

# 启动完整应用
corepack pnpm dev:server
```

打开 `http://127.0.0.1:4318`。

## 技术栈

| 层级 | 技术 | 用途 |
| --- | --- | --- |
| Web | React、TypeScript、Vite | 三栏知识库界面；Vite 只用于前端开发热更新。 |
| 编辑 | Tiptap / ProseMirror | 正文权威 JSON；Markdown 用于导入导出和 ETAPI。 |
| 服务 | Fastify、Zod | REST、ETAPI、增量同步端点、维护任务调度和静态资源托管。 |
| 领域 | TypeScript Domain Service | 笔记、placement、回收站、版本和搜索规则。 |
| 存储 | SQLite、Drizzle、FTS5 | 本地优先持久化、迁移、备份恢复与全文搜索。 |
| 桌面 / 移动 | Electron、Capacitor | 复用 Web 前端；桌面端主进程代理远端同步，移动端连接远端 HTTPS API。 |

## 文档

### 使用与维护

| 文档 | 适合何时阅读 |
| --- | --- |
| [运行与维护](docs/operations.md) | 安装依赖、启动应用、构建前端、迁移数据库、运行 FTS 或 doctor、设备配对、桌面端打包、备份与恢复。 |
| [API 与内容格式](docs/api.md) | 对接 REST、ETAPI、设备管理、受保护笔记、自动化脚本或导入导出。 |
| [ETAPI：AI 与外部自动化](docs/etapi.md) | 给 AI 签发短期令牌，读取笔记层级、正文与 tag，并安全地创建和编辑笔记。 |
| [认证与同步](docs/auth-and-sync.md) | 部署形态 A/B、设备认证、端到端加密、桌面端远端代理、多端访问与同步边界。 |
| [附件协议](docs/attachment-protocol.md) | 实现文件存储适配器、共享附件或清理任务。 |

### 设计参考

| 文档 | 内容 |
| --- | --- |
| [架构设计](docs/architecture.md) | 单端口拓扑、运行形态、桌面端远端代理、模块边界、客户端状态、认证与安全。 |
| [数据模型](docs/data-model.md) | SQLite 表、树不变量、保存与删除语义、受保护笔记存储、迁移和完整性规则。 |

## 代码结构

| 包/应用 | 职责 |
| --- | --- |
| `apps/server` | Fastify HTTP 适配器、静态资源托管、进程生命周期、认证 hook、增量同步端点、维护任务调度 |
| `packages/domain` | NoteService（笔记、树、clone、保存、搜索、受保护笔记）、AttachmentService、PlacementService（撤销/恢复、回收站管理）、Devices（内存态设备凭据） |
| `packages/database` | SQLite 连接、WAL、Schema、迁移 SQL、doctor 与 FTS 维护、备份与恢复、sync_change_log / sync_cursors / sync_tombstones 维护 |
| `packages/editor` | Markdown 转换、纯文本提取、Tiptap 编辑与静态渲染、代码高亮（15+ 语言）、行号、表格列宽保留、正文查找/替换底栏（`Ctrl+F`，区分大小写与全字匹配） |
| `packages/shared` | Zod 契约、跨端类型、系统常量（含认证常量、受保护笔记常量、附件常量） |
| `packages/api-client` | 浏览器与移动端共用的 HTTP 请求封装（携带本地令牌与设备令牌、`X-Ygdria-Sync-Origin` 头部、SRP 认证调用） |
| `apps/web` | React 三栏工作区界面（TanStack Query + Zustand 状态管理）、ProtectedClientSession（端到端加密）、RemoteProxyClient（桌面端 IPC 代理）、Markdown 导入与源码视图、搜索/归档/设置页面 |
| `apps/desktop` | Electron 主进程：本地 Fastify 内嵌、远端代理 IPC、safeStorage 凭据存储、路径白名单与 SSRF 防护、NSIS 安装程序打包 |
| `apps/mobile` | Capacitor 壳（Android/iOS）：复用 `apps/web` 的 SPA（`webDir: ../web/dist`），集成原生状态栏/深色模式、键盘 resize、Android 返回键、安全凭据存储（iOS Keychain / Android EncryptedSharedPreferences）与移动端笔记树抽屉；原生工程由 `cap sync` 生成。 |
