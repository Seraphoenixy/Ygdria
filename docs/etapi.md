# ETAPI：本机 AI 与外部访问

ETAPI 供本机 MCP 和自动化工具读取、搜索、整理笔记，默认以 Markdown 交换正文，内部权威格式仍为 Tiptap JSON。

## 1. 一个开关

桌面应用的 **设置 → 安全 → AI 与外部访问 → 允许本机工具访问** 控制全部外部读写，默认关闭。开启或关闭立即影响后续请求，无需重启；状态保存在桌面私有 `etapi-access.json`，不参与笔记同步和数据库备份。文件缺失或损坏时保持关闭。

不再签发访问令牌，不提供权限选择、有效期或会话列表。升级后旧令牌和 `etapi-sessions.json` 不再使用，外部访问默认关闭，需要用户主动开启。

仅桌面本机服务注册这些接口；独立同步服务器不提供 ETAPI。所有请求均需：

```http
X-Ygdria-External-Access: 1
```

不需要 Authorization，也不接受设备凭据作为开启开关的替代方式。服务端检查实际 socket 地址和 Host 均为 loopback，拒绝 Origin / Sec-Fetch-Site 浏览器请求。自定义请求头不列入 CORS 允许头，普通网页不能借此访问。MCP 自动添加该头，无需用户配置凭据。

开关开启后，本机工具可读写普通笔记。受保护笔记只返回脱敏树占位，正文与修改均拒绝；版本检查、修订和系统节点保护不变。外部请求不能调用桌面私有 `/api/v1/*`。

设置页使用私有管理接口 `GET /api/v1/etapi/access` 读取 `{ enabled }`，用 `PATCH /api/v1/etapi/access` 提交 `{ "enabled": true }` 或 false。这些接口继续受桌面私有凭据或设备认证保护，不提供给 MCP。旧 `/api/v1/etapi/sessions` 已移除。

## 2. 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/etapi/capabilities` | 当前访问模式、操作能力和幂等窗口。 |
| GET | `/etapi/tree/roots` | 顶层节点分页。 |
| GET | `/etapi/tree/nodes/:placementId` | 单个节点。 |
| GET | `/etapi/tree/nodes/:placementId/children` | 子节点分页。 |
| GET | `/etapi/tree/nodes/:placementId/subtree` | 有界子树。 |
| GET | `/etapi/tree/resolve` | 按标题定位候选。 |
| GET | `/etapi/notes/:id` | 笔记、正文和版本。 |
| GET | `/etapi/notes/:id/content` | 正文。 |
| GET | `/etapi/notes/:id/section` | 唯一标题路径下的正文和版本。 |
| GET | `/etapi/search` | 关键词、标签、目录组合搜索。 |
| GET | `/etapi/tags` | 标签统计。 |
| POST | `/etapi/notes` | 创建笔记，支持 Idempotency-Key。 |
| PATCH | `/etapi/notes/:id` | 原子更新标题、正文、标签或语言。 |
| PUT | `/etapi/notes/:id/content` | 带版本的正文替换。 |
| PATCH | `/etapi/notes/:id/content` | 精确文本编辑或预览。 |
| POST | `/etapi/notes/:id/operations` | 追加、章节替换、标签增删。 |
| PATCH | `/etapi/placements/:id` | 移动 placement。 |

## 3. 读取层级

先读取顶层节点，再以唯一 `placementId` 按需展开；不提供整棵根树，也不再支持名称作为树读取入口。名称只用于定位候选节点。

```http
GET /etapi/tree/roots?limit=50
GET /etapi/tree/nodes/:placementId/children?limit=50&cursor=:cursor
GET /etapi/tree/nodes/:placementId/subtree?maxDepth=2&maxNodes=100
GET /etapi/tree/resolve?query=项目&parentPlacementId=:optional-parent
X-Ygdria-External-Access: 1
```

`roots` 与 `children` 返回 `{ items, nextCursor }`，必须在 `nextCursor` 不为空时继续分页。`subtree` 只返回 `{ items }`，`maxDepth` 范围为 1–10，`maxNodes` 范围为 1–500。所有接口可用 `includeArchived=true` 纳入归档笔记。不要用 `noteId` 作为树节点 ID，因为同一笔记可以有多个 placement。

```json
{
  "items": [
    {
      "placementId": "placement-id",
      "noteId": "note-id",
      "parentPlacementId": "parent-placement-id",
      "position": 0,
      "title": "项目计划",
      "isProtected": false,
      "hasChildren": true
    }
  ]
}
```

节点仅包含 `placementId`、`noteId`、`parentPlacementId`、`position`、`title`、`isProtected` 与 `hasChildren`。默认不返回归档笔记；回收站和系统根节点不返回。受保护笔记只作为脱敏的层级占位节点出现：标题为空，正文接口会拒绝访问。

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

全文搜索和 tag 可单独使用或组合，组合条件在结果上限之前执行：

```http
GET /etapi/search?q=会议纪要&tag=项目&includeArchived=false
GET /etapi/search?tag=项目&placementId=parent-placement-id
```

`placementId` 可选；传入时搜索范围是该 placement 自身及所有后代。结果仍按笔记去重，但会以 `matchedPlacementIds` 标出树内命中的位置，正确处理 clone。受保护笔记不会进入搜索结果。

## 5. 创建和编辑

创建文本笔记时，`content` 使用 Markdown；省略 `parentPlacementId` 时创建在根节点：

```http
POST /etapi/notes
Content-Type: application/json
X-Ygdria-External-Access: 1
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

### 精确编辑正文

`PATCH /etapi/notes/:id/content` 采用 MCP 文件编辑工具常用的字面 `oldText` / `newText` 模型，不使用正则表达式。所有编辑以同一份版本快照定位、检查且原子写入；因此多个操作不会因前一个操作改变字符位置。

```json
{
  "expectedVersion": 3,
  "edits": [
    { "oldText": "## 结论\n旧结论", "newText": "## 结论\n新结论" },
    { "oldText": "- 待办 A", "newText": "- 待办 A（已完成）" }
  ]
}
```

`oldText` 默认必须恰好出现一次；需要替换多个相同片段时，显式传入 `expectedMatches`，且实际数必须完全相等。任何目标未命中、次数不符或与其他编辑重叠时，接口返回 `422 PatchTargetError`，且不会写入任何内容。`dryRun: true` 可预览结果和每项命中次数。

ETAPI 外部调用不能通过 `X-Ygdria-Import` 跳过修订记录。

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
| `403` | 外部访问已关闭，或请求不符合本机原生客户端访问条件。 |
| `404` | 笔记或 placement 不存在。 |
| `409` | 笔记版本冲突、受保护笔记被访问，或层级操作违反约束。 |
| `415` | 正文写入使用了不支持的 `Content-Type`。 |
| `422` | 精确编辑的文本目标未命中、命中次数不符或编辑区间重叠。 |

错误响应统一为：

```json
{
  "error": {
    "code": "ConflictError",
    "message": "Note changed elsewhere; refresh before saving."
  }
}
```


## 7. 持续自动化与按意图编辑

`GET /etapi/capabilities` 返回 `access: "local-read-write"`、支持的意图操作和幂等回执保留天数。

创建笔记可携带 `Idempotency-Key` 请求头（1～200 字符）。同一本机数据库、同一操作范围内，相同键和相同参数在 30 天内返回原始 `{ id, version, updatedAt }` 回执；不同参数复用同一键返回 409。携带键的创建响应固定为最小回执；需要正文时另行读取。请求结果不确定时，只能使用原键和原参数重试；未携带键时不可盲目重试。恢复旧数据库备份后不保证去重。

回执与笔记更新在同一 SQLite 事务内写入，重启后仍有效，不保存正文或凭据明文，不参与同步；数据库备份包含回执。超过 30 天的回执在下一次带键写入时清理。

`POST /etapi/notes/:id/operations` 支持：

```json
{ "operation": "append", "text": "新增段落" }
```

追加必须携带 `Idempotency-Key`。文本笔记将 Markdown 解析成 Tiptap 节点追加，保留已有节点与属性；代码笔记直接追加原始字符串，不自动添加分隔换行。`expectedVersion` 可选，省略时基于最新快照执行，最终仍通过乐观并发保存。

```json
{ "operation": "tags", "addTags": ["已整理"], "removeTags": ["待整理"] }
```

标签增删保留其他标签；同一个标签同时出现在两组时以添加为准。合并后超过现有标签上限会原子拒绝，不截断。可选 `expectedVersion` 和幂等键。

先通过 `GET /etapi/notes/:id/section?path=<URL编码的JSON数组>` 读取唯一章节，例如 path 为 `["项目","结论"]`。返回 `{ id, version, headingPath, content }`，content 是不含目标标题、包含子章节的 Markdown 正文。然后提交：

```json
{
  "operation": "replace_section",
  "headingPath": ["项目", "结论"],
  "oldText": "读取接口返回的完整 content",
  "text": "新的章节正文",
  "expectedVersion": 3
}
```

章节路径按 Tiptap heading 的祖先标题精确定位；路径不唯一、原文不匹配或版本变化均拒绝，不自动模糊匹配。保留目标标题和章节之外的原始 Tiptap 节点。仅支持文本笔记。可选幂等键；与创建、追加一样返回最小回执。

精确编辑失败时，调用方可收到 `error.diagnostics`，其中包含编辑序号、预期及实际命中数、最多 20 个候选字符偏移，不包含正文片段。

MCP 适配器可通过既有分页接口实现有预算的目录概览、批量读取和批量移动。批量移动逐项执行，允许部分成功，不构成跨请求事务。遍历整库可用于用户授权的整理任务；客户端应明确标记截断和待续位置。

ETAPI 的参数校验失败还返回 `error.validation`（最多 20 项字段路径、校验码和说明）；版本冲突返回 `error.currentVersion`。通用 API 和 5xx 响应不暴露这些诊断。
