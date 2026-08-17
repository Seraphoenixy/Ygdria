<p align="center">
  <img src="assets/icons/ygdria-forest-mark.png" alt="Ygdria" width="96" height="96" />
</p>

<h1 align="center">Ygdria</h1>

<p align="center">
  <strong>单用户 · 自托管的个人知识库</strong><br />
  树形笔记 · Tiptap 富文本 · 端到端加密的受保护笔记 · 基于游标的增量同步 · 面向 AI 的 ETAPI
</p>

<p align="center">
  <img alt="Node" src="https://img.shields.io/badge/Node.js-24%20LTS-339933?logo=node.js&logoColor=white" />
  <img alt="pnpm" src="https://img.shields.io/badge/pnpm-10-CC3534?logo=pnpm&logoColor=white" />
  <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white" />
  <img alt="Fastify" src="https://img.shields.io/badge/Fastify-5-000000?logo=fastify&logoColor=white" />
  <img alt="SQLite" src="https://img.shields.io/badge/SQLite%20%2B%20FTS5-003B57?logo=sqlite&logoColor=white" />
  <img alt="Electron" src="https://img.shields.io/badge/Electron-43-47848F?logo=electron&logoColor=white" />
  <img alt="Capacitor" src="https://img.shields.io/badge/Capacitor-7-119DFF?logo=capacitor&logoColor=white" />
  <img alt="Self-hosted" src="https://img.shields.io/badge/self--hosted-2EA043?logo=server&logoColor=white" />
  <img alt="License" src="https://img.shields.io/badge/license-Apache%202.0-0D8A2B?logo=apache&logoColor=white" />
</p>

<p align="center">
  <a href="#特性">特性</a> ·
  <a href="#架构概览">架构</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#自托管部署">自托管</a> ·
  <a href="#安全模型">安全</a> ·
  <a href="#ai-与自动化-etapi">AI / ETAPI</a> ·
  <a href="#文档">文档</a>
</p>

---

Ygdria 是一个为个人打造的、**自托管、本地优先**的知识库。它用一个 Fastify 进程在同一端口同时托管 Web 界面与 API，以树形层级组织笔记，正文采用 Tiptap JSON（权威格式）并可双向转换为 Markdown。笔记可以「克隆」到多个位置，支持受保护笔记的端到端加密、全文检索、修订历史、代码笔记与附件。多端通过基于游标的增量变更日志同步，桌面端远端访问由 Electron 主进程代理，渲染进程不持有设备令牌。

Ygdria 不是多人实时协作工具，也不使用 CRDT：它的同步模型面向「同一常驻服务器 + 多客户端」以及离线搬运、定期备份与多端合并。

> 以 Apache License 2.0 发布。详见 [许可证](#许可证) 与仓库根目录的 [LICENSE](LICENSE)。

---

## 特性

- **树形笔记与克隆（clone）**：一棵可拖拽的笔记树，同一篇笔记可出现在多个位置（通过 placement 关联），支持乐观更新与即时反馈。
- **富文本 + Markdown 双视图**：基于 Tiptap / ProseMirror 的所见即所得编辑，并可一键切换到 Markdown 源码视图；退出源码视图时自动解析回 Tiptap JSON。
- **代码笔记**：独立的代码笔记类型，内置 15+ 语言高亮（lowlight）、行号、复制与语言选择。
- **受保护笔记（端到端加密）**：以主密码派生 AES-256-GCM 密钥，正文在客户端加密后才上传；服务端只存密文，无法解密，也不进全文检索、修订与归档。
- **修订历史与 GitHub 风格差异**：查看任意修订与当前正文的 unified diff，支持整体回退，代码笔记还可逐区块回退。
- **保存冲突处理**：直接保存走乐观并发（`expectedVersion`），版本过期时弹出冲突对话框，对比「远端当前版 vs 本地未保存编辑」并提供保留/采用/稍后处理三种选择。
- **正文内查找与替换（Ctrl+F / Cmd+F）**：覆盖富文本与 Markdown 源码两种视图，支持区分大小写、全字匹配（中文按字成词），只读笔记禁用替换。
- **全文检索（SQLite FTS5）**：对正文与 tag 进行搜索，可随时在线重建索引或只读校验。
- **附件**：文件存储适配器、共享附件与清理任务，支持按哈希分片上传/下载。
- **增量同步**：`sync_change_log` / `sync_cursors` / `sync_tombstones` 三表协同，客户端用游标拉取增量并按 last-write-wins 时间戳合并，删除以墓碑表达避免旧数据复活。
- **面向 AI 的 ETAPI**：可签发的短期作用域令牌，让本机 AI 工具在受控权限下读取、搜索与编辑笔记，默认只读、15 分钟有效。
- **多端形态**：同一份 Web 前端同时用于浏览器、Electron 桌面（Windows 安装包）与 Capacitor 移动端（Android / iOS）。
- **深色模式**：浅色 / 深色 / 跟随系统三档，由「设置 → 外观」切换；首帧前写入 `data-theme` 属性避免闪烁，深色样式完全由设计令牌驱动。
- **标签系统**：为笔记添加 `tags` 属性，服务端聚合 `GET /api/v1/tags` 提供按使用次数排序的标签统计，并支持按标签检索。
- **归档与子树保护**：单篇笔记可归档（`PATCH /api/v1/notes/:id/archive`），整棵子树可一键加密保护（`protectSubtree`）；受保护子树的标题与正文都在客户端解密后才可见。
- **多标签页与拖拽排序**：工作区支持多标签页，可拖拽重排、固定与在新窗口打开；切换或拖拽时保留各标签的滚动位置。
- **表格行列管理**：富文本表格支持插入 / 删除行与列、列宽保留，并配合 GitHub 风格差异回退。
- **桌面端自动同步**：Electron 桌面在未编辑、无进行中同步且无冲突时，自动向目标服务器拉推增量，无需手动触发。
- **附件图片预览**：图片类附件可在笔记内联预览，其它附件仍走下载 / `Range` 分块下载。

---

## 架构概览

### 单端口拓扑

生产或本地正常使用时，Fastify 是**唯一应用入口**：它在同一端口（`127.0.0.1:4318`）提供 React 静态资源、REST API 与 ETAPI。

```text
浏览器 / Electron Renderer / Mobile
             │ HTTP（远端经 HTTPS 反向代理）
             ▼
      Fastify :4318（始终绑定 127.0.0.1）
       ├─ React SPA（apps/web/dist）                          ← 公开
       ├─ /api/v1/health、/ready、/auth/config、/devices/initialize、/auth/login/*、/devices/pair  ← 公开
       ├─ /api/v1        REST（受保护：本地令牌 + Bearer deviceToken）
       └─ /etapi         AI 与自动化（受保护：deviceToken 或短期 scope 令牌）
             │
             ▼
       NoteService（domain） / AttachmentService / Devices
             │
             ▼
   Drizzle / better-sqlite3 → SQLite（WAL + FTS5）
```

### 两种运行形态

同一份 `buildApp` 代码支持两种部署形态，仅由启动参数区分：

- **形态 A（桌面内嵌）**：Electron 主进程启动 Fastify，监听 loopback；Renderer 经 `contextIsolation` + `sandbox` 访问本地 API，数据库位于用户应用数据目录。默认不启用设备认证——loopback 即信任边界。
- **形态 B（独立服务器）**：`apps/server` 直接运行；多端经反向代理 HTTPS 连接，设备认证强制启用。

### 桌面端远端代理

当桌面端要把本地知识库与某台形态 B 服务器同步时，**渲染进程绝不直接请求远端**。所有远端调用由 Electron 主进程代理：主进程持有 `serverUrl` 与 `deviceToken`（`safeStorage` 加密落盘），执行路径白名单、强制 HTTPS、SSRF 防护，并拦截认证响应中的 `deviceToken` 直接写入 `safeStorage`——渲染进程永不知晓 `deviceToken` 明文。这让 CSP 无需放宽、远端无需为桌面开 CORS 例外。

### 模块边界与依赖方向

```text
Adapter（server / web / desktop / mobile）→ Domain → Database
                         ↑
                  Editor / Shared
```

Fastify 路由、Electron IPC 与 React 组件不承载核心业务规则，使桌面本地服务、远端 Web 服务与未来命令行导入器能复用同一 `NoteService`。`Devices` 是例外：它是纯内存服务，不依赖数据库，用于形态 B 的设备认证，保证凭据不进入数据库同步路径。

---

## 技术栈

| 层级 | 技术 | 用途 |
| --- | --- | --- |
| Web | React 19、TypeScript、Vite 8 | 三栏知识库界面；TanStack Query 管服务端数据，Zustand 管本地 UI 状态。 |
| 编辑 | Tiptap 3 / ProseMirror | 正文权威 JSON；Markdown 用于导入导出、源码视图与 ETAPI。 |
| 服务 | Fastify 5、Zod | REST、ETAPI、增量同步端点、维护任务调度与静态资源托管。 |
| 领域 | TypeScript Domain Service | 笔记、placement（含克隆）、回收站、版本、搜索、受保护笔记。 |
| 存储 | SQLite、Drizzle、better-sqlite3、FTS5 | 本地优先持久化、迁移、备份恢复与全文搜索。 |
| 桌面 / 移动 | Electron 43、Capacitor 7 | 复用 Web 前端；桌面主进程代理远端同步，移动端连接远端 HTTPS API。 |
| 界面样式 | 设计令牌（CSS 自定义属性） | `apps/web/src/styles/foundation/tokens.css` 为唯一主题来源；已移除 Tailwind，深色主题以令牌覆盖实现，编辑器调色板跨主题保持一致。 |

---

## 快速开始

运行环境统一使用 **Node.js 24 LTS**（24.x）；仓库根目录的 `.nvmrc` 已固定版本，建议用 `nvm` / `nvm-windows` 自动读取。包管理通过 **Corepack + pnpm 10**。

### 方式一：本地从源码运行（推荐体验）

```powershell
# 安装工作区依赖
corepack pnpm install

# 创建或升级 SQLite 数据库（可安全重复执行）
corepack pnpm --filter @ygdria/database migrate

# 构建 Web 界面，使 Fastify 可在同一端口托管它
corepack pnpm --filter @ygdria/web build

# 启动完整应用
corepack pnpm dev:server
```

打开 `http://127.0.0.1:4318`。正常使用只需要这一个服务端进程。

### 方式二：开发模式（热更新）

修改 Web 界面时另开终端启动 Vite（默认 `http://localhost:5173`），它把 `/api`、`/etapi` 代理到 `127.0.0.1:4318`：

```powershell
corepack pnpm dev
```

Vite 只提供热更新，不替代后端服务，也不是正式运行所必需的。

### 方式三：桌面安装包

Windows 安装包由 CI 在打 `v*` 标签时构建（NSIS 安装程序，输出在 `apps/desktop/dist/`）。本地构建：

```powershell
corepack pnpm --filter @ygdria/web build:electron
corepack pnpm --filter @ygdria/desktop dist:win
```

安装版把 Web 界面与本地 API 一并打包；笔记数据库保存在当前用户的应用数据目录，而非安装目录。Windows 客户端一次只允许运行一个实例：再次启动会唤醒已有窗口。它固定使用 `127.0.0.1:4318` 供本地界面与 ETAPI 使用；若该端口已被占用，应用会提示关闭占用程序后重试，不会改用其他端口。

### 方式四：Linux 独立服务包

CI 生成的 `linux-x64` 独立服务包内嵌 Node 24 运行时，目标服务器无需安装 Node.js、pnpm 或 tsx；解压后运行 `./start.sh`。首次启动会创建 `~/.config/ygdria/ygdria.ini`，数据库默认位于 `~/.local/share/ygdria/ygdria.db`，附件目录与其同级。

---

## 自托管部署

### 形态 B 的独立服务器

```text
手机 / 远程浏览器 / 第二台桌面
        │ HTTPS（反向代理）
        ▼
   反向代理（强制 HTTPS + HSTS，限制请求体/连接数/登录速率）
        │
        ▼
   Ygdria 独立服务（Fastify，设备认证强制启用）
```

- 服务端始终只监听 `127.0.0.1`；远端访问**必须**经反向代理并配置 HTTPS。
- 配置只读取 `~/.config/ygdria/ygdria.ini`，**不支持环境变量覆盖**。首次启动自动生成：

  ```ini
  [server]
  port = 4318
  host = 127.0.0.1
  origin = http://localhost:5173
  ; 反向代理的 IP/CIDR，逗号分隔；未使用反代时留空
  trusted_proxy =

  [storage]
  database_url = /home/you/.local/share/ygdria/ygdria.db

  [web]
  web_dist =
  ```

- 若把 `host` 改为非 loopback 地址，必须在反代层配置 HTTPS；反代部署时 `origin` 须为实际 HTTPS 站点源，`trusted_proxy` 只填该反代 IP/CIDR，且防火墙必须拒绝公网直接访问 Node 监听端口。
- 就绪探针 `GET /api/v1/ready` 专为负载均衡/编排器设计：不限速、不认证，SQLite 与附件目录可用时返回 `200`，否则 `503`，不暴露内部错误细节。

### 设备认证与配对（形态 B）

独立服务器始终启用设备认证，采用 **统一主密码派生 + PAKE（SRP-6a）挑战响应** 模型：用户只维护一个主密码，客户端从它派生两套彼此隔离的材料——`fileKey`（受保护笔记加密）与 `accessSecret`（作为 SRP-6a 的「密码」）。完整信任模型见 [认证、受保护笔记与同步边界](docs/auth-and-sync.md)。

> 安全提示：首次初始化（`/api/v1/devices/initialize` 是一次性公开端点，谁先成功提交谁就设定主密码）完成前，不要把反向代理开放到不可信网络。建议先经本机或受控隧道完成初始化，再开放公网入口。

---

## 安全模型

- **统一主密码**：同一个主密码既用于设备认证（派生 `accessSecret` 走 SRP-6a），也用于受保护笔记的端到端加密（派生 `fileKey`）。两条派生路径使用独立的随机盐与上下文字符串，互不复用。
- **受保护笔记（E2E）**：主密码永不离开客户端，AES-256-GCM 密钥只存在于客户端内存；服务端只存密文、`content_hash`、空 `plain_text` 与校验值，无法解密，也不进 FTS、历史与归档。
- **设备令牌**：纯内存、不持久化，只保存 `sha256(token)`；固定 **5 天滑动闲置超时**，服务器重启即全部失效，需重新走 SRP 登录。主密码明文、`fileKey`、`accessSecret`、`deviceToken` 明文均不离开客户端或不持久化。
- **登录失败不区分原因**（统一 `401`），避免泄露用户枚举或 verifier 状态；同一来源连续失败 5 次暂停登录 30 秒。

---

## AI 与自动化（ETAPI）

ETAPI 让本机 AI 工具和外部自动化在**受控权限**下读取、搜索与编辑笔记，默认以 Markdown 作为交换格式（内部由 Ygdria 转换为 Tiptap JSON）。

- 仅由**桌面应用的本机 loopback 服务**提供；在「设置 → 安全 → AI 与外部访问令牌」中创建短期令牌（默认只读、15 分钟）。
- 令牌只可访问 `/etapi/*`，不能访问 `/api/v1/*`；只在服务端内存保存 SHA-256 摘要。
- 面向 AI 的精简调用说明见 [`docs/etapi-ai.md`](docs/etapi-ai.md)；管理员与集成人员视角见 [`docs/etapi.md`](docs/etapi.md)。

---

## 同步与多端访问

Ygdria 提供**基于游标的增量同步**（`/api/v1/sync/changes|push|advance|cursor`），不是 CRDT，也不做细粒度多人实时协作。

- 首选多端模式：多客户端连接同一个常驻服务器进程（单一 SQLite 权威库），并发由乐观版本号 `expectedVersion` / `If-Match` 控制，冲突返回 `409`。
- 增量同步面向离线搬运、定期备份与多端合并：服务端在 `sync_change_log` 按自增 id 有序记录每次实体变更，客户端用游标拉取并按 last-write-wins 时间戳合并；删除由 `sync_tombstones` 墓碑表达，避免旧数据复活。
- 设备令牌不跨库迁移（纯内存）；受保护笔记因客户端加密而天然可随增量同步迁移。
- 移动端的唯一服务地址来自「设置 → 目标服务器地址」（`settings.syncServerUrl`）；历史上独立的移动端端点（`ygdria.api`，Capacitor Preferences）已在启动时一次性并入 `syncServerUrl`，后续重连一律使用该地址。

---

## 项目结构

| 包 / 应用 | 职责 |
| --- | --- |
| `apps/server` | Fastify HTTP 适配器、静态资源托管、进程生命周期、认证 hook、增量同步端点、维护任务调度。 |
| `apps/web` | React 三栏工作区界面（TanStack Query + Zustand）、ProtectedClientSession（端到端加密）、RemoteProxyClient（桌面端 IPC 代理）、Markdown 导入与源码视图、搜索/归档/设置页面。 |
| `apps/desktop` | Electron 主进程：本地 Fastify 内嵌、远端代理 IPC、safeStorage 凭据存储、路径白名单与 SSRF 防护、NSIS 安装程序打包。 |
| `apps/mobile` | Capacitor 壳（Android/iOS）：复用 `apps/web` 的 SPA（`webDir: ../web/dist`），集成原生状态栏/深色模式、键盘 resize、Android 返回键、安全凭据存储与移动端笔记树抽屉。 |
| `packages/domain` | NoteService（笔记、树、clone、保存、搜索、受保护笔记）、AttachmentService、PlacementService（撤销/恢复、回收站）、Devices（内存态设备凭据）。 |
| `packages/database` | SQLite 连接、WAL、Schema、迁移 SQL、doctor 与 FTS 维护、备份与恢复、`sync_change_log` / `sync_cursors` / `sync_tombstones` 维护。 |
| `packages/editor` | Markdown 转换、纯文本提取、Tiptap 编辑与静态渲染、代码高亮（15+ 语言）、行号、表格列宽保留、正文查找/替换底栏。 |
| `packages/shared` | Zod 契约、跨端类型、系统常量（认证常量、受保护笔记常量、附件常量）。 |
| `packages/api-client` | 浏览器与移动端共用的 HTTP 封装（携带本地令牌与设备令牌、`X-Ygdria-Sync-Origin` 头、SRP 认证调用）。 |

---

## 数据库与维护

```powershell
# 全文检索：只读校验 / 从 notes 重建 FTS
corepack pnpm check-search-index
corepack pnpm rebuild-search-index

# 完整性检查（发现问题时退出码 1）；--fix 重建可再生的 FTS 与 plain_text
corepack pnpm ygdria doctor
corepack pnpm ygdria doctor --fix

# 离线备份与恢复（须先停服）
corepack pnpm ygdria backup            # 默认 ~/ygdria-backups
corepack pnpm ygdria backup:list
corepack pnpm ygdria backup:verify <dir>
corepack pnpm ygdria restore <dir> [restore-root]
```

服务端还提供在线维护任务（`POST /api/v1/maintenance/database?rebuildFts=true`，`GET /api/v1/maintenance/status`），在专用 SQLite 连接上运行，不阻塞主连接，并有互斥与冷却保护。

---

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

---

## 开发

```powershell
corepack pnpm typecheck   # 仅 TypeScript 类型检查（不生成产物）
corepack pnpm test        # 运行测试（Vitest）
corepack pnpm build       # 构建所有工作区
corepack pnpm lint        # 校验中英文案完整性（= check-i18n，扫描 apps/web/src）
corepack pnpm check-i18n  # 校验中英文案完整性（同 lint）
```

界面文案支持简体中文（`zh-CN`）与英文（`en`），由 `apps/web/src/lib/i18n.ts` 管理，根据浏览器语言自动检测。

---

## 已知边界

- **无实时通道**：服务端不再提供 WebSocket 事件端点；实时推送是后续可选扩展。
- **同步静默覆盖**：多设备经增量同步推送（`POST /api/v1/sync/push`）并发修改同一笔记时，服务端按 last-write-wins 时间戳合并，不会返回 `409`，也不会弹出保存冲突对话框——该路径的静默覆盖目前仍未消除。
- **非多人协作**：同步不做字段级冲突，不适合双向高频实时协同。

---

## 许可证

Ygdria 以 **Apache License 2.0** 发布。

- 你可以自由使用、修改、再分发（含闭源与商业用途），只需保留版权与许可声明。
- 修改的文件须注明改动；若发行衍生作品，需附上 `LICENSE` 文本，并保留原有版权、专利、商标与署名声明。
- 许可证**明确授予专利使用权**，并对发起专利诉讼的情形终止专利授权（见第 3、5 条）。
- 软件按「原样（AS IS）」提供，不附带任何担保；作者与贡献者不承担由此产生的任何责任（见第 7、8 条）。

完整条款见仓库根目录的 [LICENSE](LICENSE) 文件。版权归属：Copyright 2026 Ygdria contributors。

---

<p align="center">
  Ygdria · 你的个人知识树，自己托管，端到端守护。
</p>
