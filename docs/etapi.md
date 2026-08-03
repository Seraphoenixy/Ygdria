# ETAPI：AI 与外部自动化接口

ETAPI 用于让 AI 工具和外部自动化在受控权限下读取、搜索和编辑 Ygdria 笔记。它以 Markdown 作为默认交换格式，内部仍由 Ygdria 转换为 Tiptap JSON 并维护修订、全文索引和同步变更记录。

本接口当前只覆盖笔记、placement 层级和 tag。

如果文档的读者是 AI 工具，请提供精简且不含管理凭据的 [`etapi-ai.md`](./etapi-ai.md)；本文档面向管理员与集成人员。

## 1. 认证模型

ETAPI 仅由 **桌面应用的本机 loopback 服务** 提供。在 **设置 → 安全 → AI 与外部访问令牌** 中创建短期令牌，再把该令牌一次性交给本机 AI 工具。令牌的名称、权限和失效时间都由用户在设置页选择；默认是只读、15 分钟。

桌面应用自身使用每次启动生成的本机凭据管理令牌；该凭据不是 AI 令牌，AI 永远不应获得它或主密码。远程独立服务器只用于同步，默认不会注册 ETAPI 或令牌管理接口。

```text
已登录的 Ygdria 设置页
  │ 创建 / 列出 / 撤销
  ▼
短期 ETAPI 令牌（明文只返回一次）
  │ Authorization: Bearer <accessToken>
  ▼
/etapi/*
```

短期令牌具有以下约束：

- 仅可访问 `/etapi/*`，不能访问 `/api/v1/*`。
- 默认有效期 15 分钟；可指定 60～3600 秒。
- 只在服务端内存保存 SHA-256 摘要，不保存令牌明文。
- 桌面应用重启、令牌到期或主动撤销后失效。
- 同时最多保留 100 个会话；达到上限时淘汰最早创建的会话。

接口监听在 `127.0.0.1`，不会向局域网或互联网暴露。若 AI 不在同一台电脑上，请使用本机代理/桥接方案，并审慎处理令牌；不要直接开放桌面端口。

### 1.1 Scope

| Scope | 能力 |
| --- | --- |
| `notes:read` | 读取层级、笔记、正文、tag 和搜索结果。 |
| `notes:write` | 创建和更新笔记、替换正文、移动 placement。 |

两个 scope 彼此独立。需要读写的 AI 应同时申请 `notes:read` 和 `notes:write`。
只有 `notes:write` 的调用方执行写操作时，响应仅包含 `{ id, version, updatedAt }`，不会借由写入响应读取原笔记内容。

### 1.2 在设置页管理令牌

设置页提供以下操作：

- 输入令牌名称（例如“研究助手”）。
- 选择只读或读写权限；只读是默认值。
- 选择 15 分钟、30 分钟或 1 小时有效期。
- 创建后立即复制令牌；关闭或刷新页面后无法再次查看明文。
- 查看仍有效的令牌及其失效时间，并可随时撤销。

### 1.3 管理 API（供设置页使用）

以下接口由桌面设置页使用，不是 AI 的 ETAPI 能力。它们受应用私有的 per-launch loopback 凭据保护；不得将该凭据提供给第三方。

```http
POST /api/v1/etapi/sessions
X-Ygdria-Local-Token: <desktop-app-private-token>
Content-Type: application/json
```

```json
{
  "label": "notes-ai",
  "scopes": ["notes:read", "notes:write"],
  "ttlSeconds": 900
}
```

成功返回 `201`。`accessToken` 仅在这次响应中出现：

```json
{
  "id": "93c0b800-bc84-4f38-9d96-a38836ccb801",
  "label": "notes-ai",
  "scopes": ["notes:read", "notes:write"],
  "createdAt": 1785769200000,
  "expiresAt": 1785770100000,
  "issuedByDeviceId": null,
  "accessToken": "yg_etapi_..."
}
```

列出会话时不会返回令牌明文：

```http
GET /api/v1/etapi/sessions
X-Ygdria-Local-Token: <desktop-app-private-token>
```

撤销令牌：

```http
DELETE /api/v1/etapi/sessions/:sessionId
X-Ygdria-Local-Token: <desktop-app-private-token>
```

## 2. ETAPI 端点

除签发、列出和撤销会话外，以下请求均使用短期令牌：

```http
Authorization: Bearer <accessToken>
```

| 方法 | 路径 | Scope | 用途 |
| --- | --- | --- | --- |
| `GET` | `/etapi/tree?includeArchived=false` | `notes:read` | 读取扁平 placement 层级和笔记属性。 |
| `GET` | `/etapi/notes/:id?format=markdown` | `notes:read` | 读取笔记元数据、placement、属性和正文。 |
| `GET` | `/etapi/notes/:id/content?format=markdown` | `notes:read` | 只读取正文；支持 `markdown`、`json`、`html`。 |
| `GET` | `/etapi/search?q=关键词` | `notes:read` | 全文搜索。 |
| `GET` | `/etapi/search?tag=标签` | `notes:read` | 精确 tag 搜索。 |
| `GET` | `/etapi/tags` | `notes:read` | 读取 tag 及使用次数。 |
| `POST` | `/etapi/notes` | `notes:write` | 创建笔记及首个 placement。 |
| `PATCH` | `/etapi/notes/:id` | `notes:write` | 原子更新标题、Markdown 正文或属性。 |
| `PUT` | `/etapi/notes/:id/content` | `notes:write` | 兼容的正文替换接口。 |
| `PATCH` | `/etapi/placements/:id` | `notes:write` | 移动一个 placement。 |

桌面应用内部的本机凭据仍可直接访问 `/etapi/*`，以兼容已有客户端；交给 AI 的凭据应始终是短期令牌。

## 3. 读取层级

```http
GET /etapi/tree
Authorization: Bearer <accessToken>
```

响应是扁平列表。使用 `placementId` 与 `parentPlacementId` 重建树；不要用 `noteId` 作为树节点 ID，因为同一笔记可以有多个 placement。

```json
{
  "items": [
    {
      "placementId": "placement-id",
      "noteId": "note-id",
      "parentPlacementId": "parent-placement-id",
      "position": 0,
      "title": "项目计划",
      "type": "text",
      "properties": { "tags": ["项目", "AI"] },
      "version": 3,
      "createdAt": "2026-08-03T10:00:00.000Z",
      "updatedAt": "2026-08-03T10:30:00.000Z",
      "archivedAt": null,
      "isProtected": false,
      "isSystem": false,
      "isCalendar": false
    }
  ]
}
```

默认不返回归档笔记；传入 `includeArchived=true` 可包含归档笔记。回收站笔记不返回。受保护笔记只作为脱敏的层级占位节点出现：标题为空、tag 为空，正文接口会拒绝访问；保留占位节点是为了让其下方普通笔记的层级仍可重建。

## 4. 读取与搜索

读取单篇笔记：

```http
GET /etapi/notes/:id?format=markdown
```

```json
{
  "id": "note-id",
  "title": "项目计划",
  "type": "text",
  "content": "# 项目计划\n\n正文",
  "contentFormat": "markdown",
  "properties": { "tags": ["项目", "AI"] },
  "placements": [
    {
      "placementId": "placement-id",
      "parentPlacementId": "parent-placement-id",
      "position": 0
    }
  ],
  "version": 3,
  "createdAt": "2026-08-03T10:00:00.000Z",
  "updatedAt": "2026-08-03T10:30:00.000Z",
  "archivedAt": null
}
```

`format=json` 对文本笔记返回 Tiptap JSON；代码笔记的正文始终是原始源代码字符串，其 `properties` 还包含 `codeLanguage`。

全文搜索和 tag 搜索二选一：

```http
GET /etapi/search?q=会议纪要&includeArchived=false
GET /etapi/search?tag=项目&includeArchived=false
```

搜索结果包含 `noteId`、标题、匹配片段、匹配字段、更新时间和 tag。受保护笔记不会进入搜索结果。

## 5. 创建和编辑

创建文本笔记时，`content` 使用 Markdown；省略 `parentPlacementId` 时创建在根节点：

```http
POST /etapi/notes
Content-Type: application/json
Authorization: Bearer <accessToken>
```

```json
{
  "title": "AI 整理结果",
  "parentPlacementId": "parent-placement-id",
  "type": "text",
  "content": "# 摘要\n\n整理后的内容",
  "tags": ["AI整理", "待确认"]
}
```

创建代码笔记时设置 `type: "code"`，`content` 直接传源代码。

编辑必须携带当前 `version`：

```http
PATCH /etapi/notes/:id
Content-Type: application/json
```

```json
{
  "expectedVersion": 3,
  "title": "确认后的标题",
  "content": "# 更新后的正文",
  "tags": ["已确认"]
}
```

标题、正文和 tag 在一次领域更新中原子写入，并只增加一次版本号。如果版本已经变化，返回 `409 Conflict`；AI 必须重新读取笔记、重新生成修改，不应无条件重试旧内容。

兼容的正文替换接口使用 `If-Match`：

```http
PUT /etapi/notes/:id/content
Content-Type: text/markdown
If-Match: 3

# 新正文
```

也可使用 `Content-Type: application/json` 写入经过校验的 Tiptap JSON。

短期 ETAPI 令牌不能通过 `X-Ygdria-Import` 跳过修订记录；该兼容头只对受信任的设备调用生效。

移动 placement：

```http
PATCH /etapi/placements/:placementId
Content-Type: application/json
```

```json
{
  "parentPlacementId": "new-parent-placement-id",
  "position": 0
}
```

服务端会继续执行既有的系统节点保护和层级循环检测。ETAPI 当前不提供永久删除或清空回收站能力。

## 6. 错误处理

| 状态码 | 含义 |
| --- | --- |
| `400` | 请求体、查询参数或 `If-Match` 不合法。 |
| `401` | 令牌缺失、无效、过期或已撤销。 |
| `403` | 短期令牌缺少所需 scope。 |
| `404` | 笔记、placement 或会话不存在。 |
| `409` | 笔记版本冲突、受保护笔记被访问，或层级操作违反约束。 |
| `415` | 正文写入使用了不支持的 `Content-Type`。 |

错误响应统一为：

```json
{
  "error": {
    "code": "ConflictError",
    "message": "Note changed elsewhere; refresh before saving."
  }
}
```
