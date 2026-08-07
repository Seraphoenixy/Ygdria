# 架构设计

## 1. 运行形态

Ygdria 是单用户、自托管的个人知识库。生产或本地正常使用时，Fastify 是唯一应用入口：它在同一端口提供 React 静态资源、REST API 和 ETAPI。

```text
浏览器 / Electron Renderer / Mobile
             │ HTTP（远端经 HTTPS 反向代理）
             ▼
      Fastify :4318（始终绑定 127.0.0.1）
       ├─ React SPA（apps/web/dist）                            ← 公开
       ├─ /api/v1/health                                         ← 公开
       ├─ /api/v1/ready                                          ← 公开（探活，不限速）
       ├─ /api/v1/auth/config                                    ← 公开（PAKE 参数）
       ├─ /api/v1/devices/initialize                             ← 公开（一次性注册）
       ├─ /api/v1/auth/login/{challenge,verify}                 ← 公开（SRP-6a 挑战/响应）
       ├─ /api/v1/devices/pair                                   ← 公开（一次性配对）
       ├─ /api/v1        REST（受保护：本地令牌 + Bearer deviceToken）
       └─ /etapi         AI 与自动化（受保护：deviceToken 或短期 scope 令牌）
             │
             ▼
   ┌─────────────── 设备认证层（onRequest hook）───────────────┐
   │ • 形态 B 强制启用；形态 A 默认关闭（loopback 即信任边界）   │
   │ • /api 校验 deviceToken；/etapi 也接受短期 scope 令牌         │
   │ • Devices（纯内存）只保留 sha256(token)，5 天滑动闲置超时    │
   │ • 公开路径白名单见 auth-and-sync.md §2.2                    │
   └─────────────────────────────────────────────────────────┘
             │
             ▼
       NoteService（domain） / AttachmentService / Devices
             │
             ▼
Drizzle / better-sqlite3 → SQLite（WAL + FTS5）
   settings 表存储：auth_access_salt / auth_srp_salt / auth_srp_verifier
                    auth_protocol_version / auth_kdf_version / auth_pbkdf2_iterations
                    auth_access_secret_context / auth_srp_username
                    protected_session_{salt,verifier,timeout_ms}
   notes / revisions 存储采用 BLOB + codec（identity / zstd-v1 / ciphertext-v1）
   sync_change_log 表按自增 id 有序记录每次实体变更，供增量同步使用
   sync_tombstones 表通过触发器记录每条实体的删除，供多端同步使用
   sync_cursors 表维护每个 peer 的游标（lastAdvanceId），游标为 0 时表示无历史同步
```

开发 UI 时，可选启动 Vite 的热更新服务器；它会代理 `/api` 与 `/etapi` 到 `127.0.0.1:4318`。Vite 不属于最终用户运行所需的服务。

> **注意**：服务端不再提供 `/api/v1/events` WebSocket 端点。事件推送能力是后续可选扩展，当前架构不包含实时通道。

## 1.1 两种运行形态

同一份 `buildApp` 代码支持两种部署形态，仅由启动参数区分（详见 [认证、受保护笔记与同步边界](auth-and-sync.md)）：

- **形态 A（桌面内嵌）**：Electron 主进程启动 Fastify，监听 loopback；Renderer 经 `contextIsolation` + `sandbox` 访问本地 API，数据库位于用户应用数据目录。默认不启用设备认证——loopback 即信任边界。
- **形态 B（独立服务器）**：`apps/server/src/index.ts` 直接运行；多端（手机、远程浏览器、第二台桌面）经反向代理 HTTPS 连接。设备认证强制启用。

## 1.2 桌面端远端代理（形态 A → 形态 B）

当桌面端要把本地知识库与某台形态 B 服务器同步时，**渲染进程绝不直接请求远端**。所有远端调用由 Electron 主进程代理：

```text
渲染进程 (React UI)
  │ IPC：受限的 "remote:*" 操作（不含 deviceToken）
  ▼
Electron 主进程
  ├─ 持有 serverUrl 与 deviceToken（safeStorage 加密落盘）
  ├─ 路径白名单（13 条精确前缀，非任意 URL）
  ├─ 强制 HTTPS、禁止 HTTP 重定向（redirect: 'error'）
  ├─ 注入 Authorization: Bearer <deviceToken>
  ├─ SSRF 防护：解析后 origin 必须与配置的 serverUrl 一致
  └─ 拦截 /devices/initialize 与 /auth/login/verify 响应中的 deviceToken
     → 直接写入 safeStorage，返回脱敏响应给渲染进程
  │ Node fetch（不受浏览器 CORS 限制）
  ▼
HTTPS 远端服务（形态 B）
```

这样做的动机：

- **CSP 无需放宽**：渲染进程只与 `127.0.0.1:4318` 同源通信，`connect-src 'self'` 继续生效，缩小 XSS 后的外传通道。
- **远端服务器无需为桌面端开 CORS 例外**：主进程的 Node fetch 不受浏览器 CORS 约束。
- **deviceToken 永不进入渲染进程**：主进程在 IPC 内部拦截 `initialize` / `verify` 响应，把 token 写入 safeStorage，只把脱敏后的对象回传给渲染进程。
- **SSRF 防护**：IPC 只接受路径白名单（认证、同步、附件按哈希上传/下载），禁止任意 URL；解析后的 origin 必须与用户确认的 serverUrl 一致；`redirect: 'error'` 阻断 origin 跳变。

浏览器模式（非 Electron）仍使用直接的 `YgdriaClient`：此时浏览器页面与服务器同源，CSP `connect-src 'self'` 允许请求，deviceToken 保存在 `sessionStorage`。

## 2. 模块边界

```text
apps/server      HTTP adapter、静态资源托管、进程生命周期、设备认证 hook（SRP challenge/verify、Devices 服务）、增量同步端点、维护任务调度
packages/domain  NoteService（笔记、树、克隆、保存、搜索、受保护笔记）、AttachmentService、PlacementService（撤销/恢复、回收站管理）、Devices（内存态设备凭据 + 5 天闲置超时）
packages/database SQLite 连接、WAL、Schema、迁移 SQL、doctor 与 FTS 维护、备份与恢复、sync_change_log / sync_cursors / sync_tombstones 维护
packages/editor  Markdown 转换、纯文本提取、Tiptap 编辑与静态渲染
packages/shared  Zod 契约、跨端类型、系统常量（含 SRP_USERNAME / ACCESS_SECRET_CONTEXT / PBKDF2 迭代次数 / DEVICE_TOKEN_IDLE_TIMEOUT_MS 等认证常量）
packages/api-client 浏览器与移动端共用的 HTTP 请求封装（携带本地令牌与设备令牌、authConfig / SRP challenge / verify 调用）
apps/web         React 用户界面、ProtectedClientSession（端到端加密）、客户端主密码派生与 SRP 客户端逻辑、RemoteProxyClient（桌面端 IPC 代理）
apps/desktop     Electron 主进程：本地 Fastify 内嵌、远端代理 IPC、safeStorage 凭据存储、路径白名单与 SSRF 防护
apps/mobile      Capacitor 壳（Android/iOS）：复用 apps/web 的 SPA（webDir: ../web/dist），集成原生状态栏/深色、键盘 resize、Android 返回键、安全凭据存储（capacitor-secure-storage-plugin）与移动端笔记树抽屉；原生工程经 cap sync 纳入。移动端的唯一服务地址统一为设置中的「目标服务器地址」`settings.syncServerUrl`（启动时把遗留的 `ygdria.api` 一次性并入），deviceToken 经 capacitor-secure-storage-plugin 安全存储。
```

依赖方向必须保持为：

```text
Adapter → Domain → Database
          ↑
       Editor / Shared
```

Fastify 路由、Electron IPC 与 React 组件不承载核心业务规则。这样桌面本地服务、远端 Web 服务和未来命令行导入器能够复用同一 `NoteService`。`Devices` 是例外：它是纯内存服务，不依赖数据库，专门用于形态 B 的设备认证，保证凭据不进入数据库同步路径。

## 3. 单端口静态资源托管

在服务端启动时，`apps/server/src/app.ts` 会定位 `apps/web/dist`。若该目录存在：

- `/assets/*` 返回经过路径穿越检查的前端构建资源；
- 其他非 API 的 GET 请求返回 `index.html`，由 React SPA 路由接管；
- `/api/*`、`/etapi/*` 路由在 SPA 回退前由 Fastify 的具体路由处理。

构建与启动命令、端口和开发代理说明统一放在 [运行与维护](operations.md#2-首次启动)。本节只定义部署约束：生产模式必须先有 `apps/web/dist`，并由同一个 Fastify 进程在 `127.0.0.1:4318` 提供 SPA 与 API。

## 4. 客户端状态原则

TanStack Query 保存服务端数据、请求状态与失效策略。Zustand 只保存：

- 当前选中的笔记；
- 编辑/阅读状态；
- 界面主题和语言；
- 临时面板状态。

Tiptap 的实时 ProseMirror 文档不进入 Zustand。编辑器内部维护事务状态，防抖后再把最新 JSON 提交给服务端；保存失败时编辑器本地状态仍保留。`autoSave` 采用「1s 尾随去抖 + 以快照间隔为上限的时间窗」：连续输入至多每间隔保存一次，且因无停顿而永不 flush 的情况也被时间窗兜住，不会丢失编辑；服务端再按快照间隔节流修订写入，避免连续输入每次击键都建一条修订。细节见 [数据模型 §4.1](data-model.md#41-客户端自动保存去抖与修订节流)。

## 4.1 工作区界面架构

Web 前端（`apps/web`）实现三栏布局，所有组件在 `App.tsx` 中编排：

```text
┌──────────────┬──────────────────────────────────────┬──────────────┐
│  左侧面板    │              中间面板                 │  右侧面板     │
│  (TreePanel) │  (TabBar + Toolbar + Content)         │ (NoteInspector│
│              │                                       │  + Outline)   │
│  笔记树      │  标签页栏 (TabBar)                    │  笔记属性     │
│  搜索        │  工具栏 (Toolbar)                     │  大纲         │
│  归档        │  NoteContent                          │  大小统计     │
│  设置        │    ├─ YgdriaEditor (text 笔记)        │              │
│              │    │   ├─ 富文本编辑 (Tiptap)          │              │
│              │    │   ├─ Markdown 源码视图            │              │
│              │    │   └─ 只读渲染 (StaticDocument)    │              │
│              │    └─ YgdriaEditor (code 笔记/代码块)  │              │
│              │       ├─ 代码编辑 (CodeNoteEditor)     │              │
│              │       └─ 代码高亮显示 (CodeBlock)      │              │
└──────────────┴──────────────────────────────────────┴──────────────┘
```

### 4.1.1 状态管理

- **TanStack Query**：管理服务端数据（笔记树、笔记内容、附件、搜索等），负责缓存、失效和重试。
- **Zustand**：只保存客户端本地状态——选中笔记、编辑/只读模式、主题、语言、面板折叠状态、Markdown 视图开关、Toast 提示。
- **Tiptap Editor**：内部维护 ProseMirror 事务状态，不进入 Zustand；防抖后通过 `onSave` 回调持久化。
- **React Query key 设计**：`NoteInspector` 的尺寸查询使用 `[placementId, note.id, note.version]` 复合 key，避免切换笔记时显示旧数据。

### 4.1.2 主要组件

| 组件 | 路径 | 职责 |
| --- | --- | --- |
| `App` | `apps/web/src/app/App.tsx` | 工作区根组件，编排三栏布局、标签页、路由和全局状态 |
| `TreePanel` | `components/navigation/TreePanel.tsx` | 左侧笔记树面板，含树形导航、展开/折叠、上下文菜单 |
| `NoteTree` | `components/navigation/NoteTree.tsx` | 递归树节点渲染，支持拖拽、多选、加号新建子笔记 |
| `TreeContextMenu` | `components/navigation/TreeContextMenu.tsx` | 右键菜单：剪切/复制/粘贴/移动/归档/删除 |
| `TabBar` | `components/chrome/TabBar.tsx` | 标签页栏，管理多笔记切换、关闭、固定 |
| `Toolbar` | `components/chrome/Toolbar.tsx` | 笔记操作工具栏（归档/删除/恢复/克隆/版本历史/导入 Markdown/源码切换） |
| `NoteContent` | `features/note/NoteContent.tsx` | 笔记内容区域，渲染编辑器或只读视图，处理标题修改和附件上传 |
| `NoteInspector` | `features/note/NoteInspector.tsx` | 右侧面板：笔记属性、大纲、存储大小 |
| `YgdriaEditor` | `@ygdria/editor` | 核心编辑器组件，封装 Tiptap，支持富文本/Markdown 视图切换 |
| `CodeBlock` | `@ygdria/editor` | 代码块节点视图，支持语言选择、行号、复制和高亮 |
| `StaticDocument` | `@ygdria/editor` | 只读渲染器，渲染 Tiptap JSON 为不可编辑的 HTML |

### 4.1.3 编辑器生命周期

编辑器实例由 `YgdriaEditor` 管理，关键生命周期策略：

- **`key` prop 驱动重建**：`NoteContent` 使用 `key={\`${note.id}:${mode}\`}` 确保切换笔记或编辑/只读模式时重建编辑器，避免 Tiptap 内部状态泄漏。
- **`documentId` 保护**：编辑器通过 `documentId` 感知所属笔记，切换笔记时用 `setContent(..., { emitUpdate: false })` 同步内容，不触发保存。
- **`onUpdate` 只读守卫**：`onUpdate` 回调仅在 `editor.isEditable` 为真时调用 `onSave`，防止只读模式下的插件/选区事务误写入服务端。
- **Markdown 视图**：切换为 Markdown 源码时，编辑器将纯文本保存到 `textarea` 供用户编辑；退出 Markdown 视图时，自动重新解析 Markdown 为 Tiptap JSON 并保存。

### 4.1.4 笔记树架构

笔记树基于扁平 placement 列表由客户端重建为嵌套树结构：

- 服务端 `GET /api/v1/tree` 返回扁平 placement 列表，客户端按 `parent_placement_id` 递归构建树。
- 根节点（系统根）、回收站、日历为系统固定 placement，不可删除、移动或重命名。
- 支持 clone（同一笔记出现在多个树位置），通过 `note_id` 关联。
- 展开/折叠状态为客户端本地状态，不持久化到服务端。
- 树操作（新建、移动、删除、clone）通过乐观更新 + TanStack Query 失效实现即时反馈。

### 4.1.5 正文查找与替换（Ctrl+F）

编辑器底栏提供正文内的查找与替换能力，覆盖富文本与 Markdown 源码两种视图，组件为 `packages/editor/src/SearchReplaceBar.tsx`。

**触发与关闭**
- 在编辑器区域按 `Ctrl+F`（macOS 为 `Cmd+F`）唤起底栏；`YgdriaEditor` 在 `window` 上监听该组合键并 `preventDefault`，阻止浏览器原生查找，同时预填当前选区文本。
- 点击右上角 `×` 或输入框内按 `Esc` 关闭；富文本视图关闭时调用 `clearSearch` 清除高亮与选区。
- 底栏以 `position: sticky` 吸附在正文区域底部，含亮/暗主题适配（`apps/web/src/styles/content/editor.css` 的 `.ygdria-search-bar` 及 `data-theme="dark"` 分支）。

**交互**
- 搜索框 + 「区分大小写」「全字匹配」两个开关；上/下一个导航按钮与 `当前 / 总数` 计数；替换框 +「替换」「全部替换」按钮。
- 键盘：回车 = 下一个、Shift+回车 = 上一个、Esc = 关闭。
- 只读笔记禁用「替换 / 全部替换」（搜索仍可用），通过 `readOnly` prop 控制。

**富文本路径（Tiptap）**
- `packages/editor/src/search-replace.ts` 导出 `SearchReplace` 扩展，注册一个 ProseMirror 插件（`searchPluginKey`），内部状态为 `{ term, options, matches, current }`。
- 匹配由 `computeMatches` 遍历文本节点得到；插件用 `Decoration` 高亮全部匹配，当前匹配使用更强的 `ygdria-search-current` 样式，并把选区移动到当前匹配后平滑滚动定位。
- 正则由 `buildSearchRegex` 生成：先转义正则元字符；全字匹配使用 Unicode 感知的零宽断言 `(?<![\p{L}\p{N}])(term)(?![\p{L}\p{N}])`，使中文等每个 `\p{L}` 即词边界；区分大小写切换 `i` 标志（基础 `u` / `gu` / `gui`）。
- 命令（`@tiptap/core` 的 `Commands` 接口增强）：`setSearchTerm`、`setSearchOptions`、`searchNext`、`searchPrev`、`replaceCurrent`、`replaceAll`、`clearSearch`。
- 替换：`replaceCurrent` 在当前匹配处 `tr.insertText` 后重算匹配；`replaceAll` 从末尾匹配向前应用，保证偏移量有效。

**Markdown 源码路径**
- `SearchReplaceBar` 复用同一套正则构建器（`computePlainMatches`），基于 `textarea` 选区与 `markdownText` 计算匹配；用 `setSelectionRange` 高亮当前匹配；替换直接对字符串切片拼接后回写 `onMarkdownChange`，只读时禁用。

**文案与测试**
- 中英文案位于 `apps/web/src/lib/i18n.ts` 的 `findReplace` 词组（`findReplace`、`findPlaceholder`、`replacePlaceholder`、`matchCase`、`wholeWord`、`findPrev`、`findNext`、`replaceCurrent`、`replaceAll`、`findNoResult`、`findMatchCount`）。
- 正则与匹配逻辑由 `packages/editor/src/search-replace.test.ts` 覆盖（大小写、全字匹配含中文按字成词、CJK、偏移量计算）。

### 4.1.6 修订历史差异与回退

笔记的「查看修订历史」对话框（`apps/web/src/components/note/RevisionHistoryDialog.tsx`）以 **GitHub 风格的统一差异（unified diff）** 展示所选修订与当前正文的差别，并提供回退能力。差异计算与渲染已抽离为可复用的 `DiffView` 组件（`apps/web/src/components/note/DiffView.tsx`，导出 `linesFromContent` / `lcsDiff` / `buildHunks` / `revertHunk` / `DiffView`）；保存冲突对话框（[§4.1.7](#417-保存冲突提示)）复用同一组件，避免 diff 逻辑重复。

**差异渲染**
- 采用 LCS 动态规划算法（`lcsDiff`）计算 `修订 → 当前` 的行级操作序列，再以 3 行上下文（`CONTEXT_LINES`）聚合成 hunk，每个 hunk 渲染 `@@ -oldStart,oldLines +newStart,newLines @@` 头部。
- 每行带左/右两侧行号（修订侧 / 当前侧）与符号栏（`+` / `−` / 空格），新增行浅绿、删除行浅红——与 GitHub 一致。
- 富文本（Tiptap JSON）与代码（字符串）笔记均先经 `linesFromContent` 扁平化为文本行再比较；修订内容来自 `GET /api/v1/notes/:id/revisions/:revisionId`，当前内容来自 `note.data.content`（代码笔记即原始代码字符串）。

**回退**
- **逐区块回退（仅代码笔记）**：每个 hunk 头部提供「回退此区块」按钮。它将当前正文对应 hunk 的新侧区域替换为旧侧行（context + removed），即把该区块恢复到修订版本，再 `PATCH /api/v1/notes/:id` 提交 `code`（走乐观并发 `expectedVersion`）。富文本因内容为 JSON、无法由文本行无损还原，故禁用逐区块回退。
- **整体回退**：右上角「整体回退到该版本」调用 `POST /api/v1/notes/:id/revisions/:revisionId/restore`（即 `client.restoreRevision`），将整篇正文恢复为目标修订；代码与富文本笔记均可用，受保护笔记无修订故不可用。
- 回退成功后通过 `queryClient.invalidateQueries` 刷新 `["note", id]` 与 `["revisions", id]`，编辑器随之重载新正文；回退失败（如版本冲突 `409`）显示错误提示。

**文案**
- 位于 `apps/web/src/lib/i18n.ts` 的修订词组：`revertRevision` / `revertRevisionTitle` / `revertHunk` / `revertHunkTitle` / `codeOnlyRevertHint` / `revisionNoDiff` / `reverting` / `revertFailed`。

### 4.1.7 保存冲突提示

直接保存（`PATCH /api/v1/notes/:id`）走乐观并发控制：请求携带 `expectedVersion`，服务端用 `WHERE id = ? AND version = ?` 条件更新，版本过期时返回 `409 Conflict`（`error.code === "ConflictError"`）。Web 客户端通过 `api-client` 附加到错误对象上的 `code` / `statusCode` 字段识别该状态（而非匹配消息文本），拦截后弹出 **保存冲突对话框**（`apps/web/src/components/note/ConflictDialog.tsx`）。

**检测与流程**

- `useNotes` 的 `save` mutation 在 `onError` 中若 `isConflictError(error)` 为真，则 `setConflict({ noteId, type, isProtected, localContent })` 记录本地未保存内容，并把 `conflict` 暴露给 `App`；`App` 据此挂载 `ConflictDialog`。
- 对话框挂载时调用 `client.getNote(conflict.noteId)` 拉取**服务端最新内容**与版本号，确保 diff 两侧分别是「远端当前版」与「本地未保存编辑」。

**差异展示（复用 DiffView）**

- 复用 §4.1.6 抽出的 `DiffView` 组件以 GitHub 风格统一差异展示 server（红 / 删除侧）vs local（绿 / 新增侧）的行级差异；富文本（Tiptap JSON）与代码（字符串）均先 `linesFromContent` 扁平化为文本行再比较。
- **受保护笔记**内容对客户端不透明，无法逐行 diff，对话框仅显示「该笔记已受保护，无法展示差异」的提示，三种处理仍然可用。

**三种处理（`resolveConflict`）**

| 处理 | 行为 |
| --- | --- |
| 保留我的修改（keepMine） | 以服务端最新版本作为新的 `expectedVersion` 重新 `save` —— 即用户在查看 diff 后**显式**覆盖远端；按钮在服务器内容加载完成前禁用。 |
| 采用远端版本（takeTheirs） | `invalidateQueries(["note", id])` 与 `["history"]`，丢弃本地未保存编辑，采用远端内容（编辑器随之重载）。 |
| 稍后处理（dismiss） | 关闭对话框，**保留编辑器中的本地未保存编辑**，不做任何服务端动作；用户可稍后再次保存（届时可能再次冲突）。 |

**已知边界**：该对话框只拦截「直接保存」这条 HTTP 路径的 409。多设备经增量同步推送（`POST /api/v1/sync/push`）并发修改同一笔记时，服务端按 last-write-wins 时间戳合并（见 [认证、受保护笔记与同步边界 §5](auth-and-sync.md#5-同步机制)），不会返回 409，也**不会**弹出此对话框——该路径的静默覆盖目前仍未消除。

## 5. 生命周期与安全

服务端始终仅监听 `127.0.0.1`；远端访问需经反向代理。收到 `SIGINT` 或 `SIGTERM` 时，入口会依次关闭 Fastify、执行 `onClose` 钩子（先 `wal_checkpoint(TRUNCATE)` 再关闭 SQLite），然后退出，避免 `tsx watch` 开发时遗留端口或数据库句柄。

Electron 的 Renderer 不开放 Node integration、文件系统、数据库连接或任意命令执行；`contextIsolation` + `sandbox` 默认开启。桌面主进程在同一进程内启动本地 Fastify，监听 loopback。形态 B 的远端服务器凭据（`serverUrl` + `deviceToken`）由主进程持有，经 Electron `safeStorage` 加密后落盘到用户数据目录；**渲染进程只能通过 `ygdria:remote:*` IPC 间接访问远端，且永不知晓 deviceToken 明文**。

### 5.1 认证

两层认证可叠加，按请求顺序执行（详见 [认证、受保护笔记与同步边界](auth-and-sync.md)）：

- **本地令牌**（`X-Ygdria-Local-Token`）：共享密钥，由 `buildApp({ localToken })` 传入；为空时不校验。形态 A 默认不设置。
- **设备凭据**（`Authorization: Bearer <deviceToken>`）：独立服务强制启用。采用 **统一主密码派生 + PAKE（SRP-6a）挑战响应** 模型：用户只维护一个主密码，客户端从它派生两套彼此隔离的材料（文件加密密钥 `fileKey` 与服务访问密钥 `accessSecret`），后者作为 SRP-6a 的“密码”参与挑战-响应。`Devices` 服务是**纯内存**实现——只保留 `sha256(token)`，不持久化；服务器重启即失效，需用主密码再次走 SRP 登录。设备令牌还有固定的 5 天滑动闲置超时（`DEVICE_TOKEN_IDLE_TIMEOUT_MS`），过期即被回收。服务端 `settings` 表只保存 `auth_access_salt`、`auth_srp_salt`、`auth_srp_verifier` 与协议/KDF 版本元数据；主密码明文、`fileKey`、`accessSecret`、`deviceToken` 明文均不离开客户端或不持久化。这保证设备凭据绝不进入数据库同步路径。

### 5.2 受保护笔记

受保护笔记采用客户端端到端加密：主密码永不离开客户端，PBKDF2 派生的 AES-256-GCM 密钥只存在于客户端内存。服务端只保存密文、`content_hash`、空的 `plain_text` 和校验值（verifier），无法解密。受保护笔记不进 FTS、history 和归档列表。完整模型见 [auth-and-sync.md](auth-and-sync.md#4-受保护笔记端到端加密)。

### 5.3 同步与多端访问

Ygdria 提供**基于游标的增量同步**（`/api/v1/sync/changes|push|advance|cursor`），不是 CRDT，也不做细粒度多人实时协作。首选的多端模式是多客户端连接同一个常驻服务器进程（单一 SQLite 权威库），并发由乐观版本号 `expectedVersion` / `If-Match` 控制，冲突返回 `409`。增量同步面向离线搬运、定期备份与多端合并：服务端在 `sync_change_log` 表中按自增 id 有序记录每次实体变更，客户端用游标拉取增量并按 last-write-wins 时间戳合并；删除由 `sync_tombstones` 表的墓碑表达，避免旧数据复活。它不处理字段级冲突，不适合双向高频同步。设备令牌不跨库迁移（纯内存），受保护笔记因客户端加密而天然可随增量同步迁移。详见 [auth-and-sync.md](auth-and-sync.md#5-同步机制)。

## 6. 主题、设计令牌与样式系统

Ygdria 的界面样式不依赖任何 CSS 框架（已移除 Tailwind），全部由一套集中的 CSS 自定义属性（设计令牌）驱动，定义在 `apps/web/src/styles/foundation/tokens.css`，由 `style.css` 顶部 `@import` 引入，确保后续所有样式表都能消费这些变量。

### 6.1 设计令牌

`tokens.css` 是主题化值的唯一来源，分为几类：

- **半径 / 间距 / 阴影**：`--radius-*`、`--space-*`、`--elevation-*`、`--ring-*` 等刻度，分别从 `scripts/tokenize_css.py` 的 `RADIUS` / `SPACING` / `SHADOW` 映射转录而来。
- **颜色语义令牌（浅色默认）**：`--color-bg`、`--color-surface`、`--color-fg`、`--color-border`、`--color-accent`、`--color-danger`、`--color-success`、`--color-warning` 等。新增或调整样式时应优先使用这些语义令牌，而非硬编码十六进制。
- **文档与编辑器令牌**：`--doc-*`、`--code-*`、`--toolbar-*`、`--popover-*`、`--search-*`、`--table-*`、`--blockquote-*`、`--task-*`、`--note-reference-*` 等，覆盖正文、代码高亮、工具栏、弹层、搜索底栏与表格的配色。
- **编辑器调色板（跨主题恒定）**：`--editor-text-*` 与 `--editor-highlight-*` 仅定义在 `:root`，不被深色主题覆盖——用户在笔记中挑选的颜色在任何主题下保持一致，并随文档可移植。
- **字体与字号**：`--font-sans` / `--font-serif` / `--font-mono` 与 `--text-*` 字号刻度（px 制，保证 UI 尺寸可预测）。

### 6.2 深色模式

深色样式不是逐条规则重写，而是在 `:root[data-theme="dark"]` 下对上方语义令牌做**覆盖**（颜色取自 GitHub-dark 调色板，`--color-accent` 在深浅色中保持同一色相）。因此任何消费令牌的组件都会自动适配深色，无需各自编写 `dark` 分支。

主题切换由 `apps/web/src/lib/theme.ts` 驱动：

- `settings.theme`（`StoredSettings.theme`）取值 `light` / `dark` / `system`，默认 `system`；它持久化在 `localStorage["ygdria.settings"]`，由 `settingsStore.ts` 的 `readSettings()` / `writeSettings()` 同步读写。
- `applyTheme()` 在 `main.tsx` **首帧之前**调用，把解析出的主题写到 `<html data-theme>`；`App.tsx` 监听系统配色变化（`prefers-color-scheme`）并在设置变更时重新调用——这样不会出现主题闪烁。
- 「设置 → 外观」的 `<select>` 改变 `settings.theme` 后立即 `applyTheme()`。
- 移动端 `capacitor.ts` 根据 `data-theme` 同步原生状态栏样式（浅色 / 深色）。
