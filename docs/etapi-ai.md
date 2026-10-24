# Ygdria ETAPI：给 AI 的调用说明

通过本机 `http://127.0.0.1:4318/etapi/*` 读写笔记。用户先在桌面设置开启 **AI 与外部访问**；关闭时请求返回 403。无需访问令牌，不要索取主密码、设备令牌或桌面私有凭据，也不要调用 `/api/v1/*`。

每个请求添加 `X-Ygdria-External-Access: 1`，MCP 服务会自动处理。只支持本机原生客户端，不支持网页或远程直接调用。

用户授权整理、归类、生成或编辑任务后，可连续完成范围内的必要操作，无需逐项确认。替换已有内容前读取内容和版本；发生 409 时基于最新状态重新判断。创建和追加使用幂等键；未携带键的创建不能在网络异常后盲目重试。受保护笔记不可读取或修改。ETAPI 不提供永久删除或清空回收站能力。

## 读取接口

### 获取层级

```http
GET /etapi/tree/roots?limit=50
```

可先用 `roots` 获取顶层节点，或按名称直接解析目标，再用唯一的 `placementId` 导航。用户任务需要时允许遍历整库，应限制每次响应的深度、节点数和字节数并标明截断。`roots` 和 `GET /etapi/tree/nodes/:placementId/children` 均分页返回 `{ items, nextCursor }`。名称仅用于 `GET /etapi/tree/resolve?query=...` 定位候选节点；再用候选的 `placementId` 读取节点、子节点或子树。受限子树接口为 `GET /etapi/tree/nodes/:placementId/subtree?maxDepth=2&maxNodes=100`。同一笔记可有多个 placement，因此不要把 `noteId` 当作树节点 ID。

每项主要字段：

```json
{
  "placementId": "placement-id",
  "noteId": "note-id",
  "parentPlacementId": "parent-placement-id-or-null",
  "position": 0,
  "title": "笔记标题",
  "isProtected": false,
  "hasChildren": true
}
```

树响应只含导航所需字段。默认不返回归档笔记、回收站笔记或系统根节点。`includeArchived=true` 可包含归档笔记。

### 读取一篇笔记

```http
GET /etapi/notes/:noteId?format=markdown
```

文本笔记默认返回 Markdown 正文；可用 `format=json` 获取 Tiptap JSON。响应包含 `id`、`title`、`type`、`content`、`contentFormat`、`properties.tags`、`placements`、`version` 和时间字段。

只读取正文：

```http
GET /etapi/notes/:noteId/content?format=markdown
```

`format` 可为 `markdown`、`json` 或 `html`。代码笔记的正文始终是源代码字符串，`properties.codeLanguage` 表示语言。

### 搜索和 tag

关键词与 tag 可单独使用或组合：

```http
GET /etapi/search?q=会议纪要&tag=项目&includeArchived=false
GET /etapi/search?tag=项目&placementId=parent-placement-id
GET /etapi/tags
```

传入 `placementId` 时，搜索仅覆盖该树节点及全部子节点；结果中的 `matchedPlacementIds` 可用于定位 clone 的树内位置。受保护笔记不会出现在搜索结果中。

## 写入接口

在用户授权的任务范围内使用；任务级授权包括完成该任务所需的创建、编辑和移动，无需逐项再问。

### 创建笔记

```http
POST /etapi/notes
Content-Type: application/json
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

省略 `parentPlacementId` 会在根节点创建。文本笔记 `content` 使用 Markdown；代码笔记设置 `type: "code"`，`content` 传原始源代码。

### 原子更新标题、正文或 tag

```http
PATCH /etapi/notes/:noteId
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

至少提供 `title`、`content`、`tags` 或 `codeLanguage` 中的一项。它们会在一次更新中原子保存，并只增加一次版本号。

### 替换正文

```http
PUT /etapi/notes/:noteId/content
Content-Type: text/markdown
If-Match: 3

# 新正文
```

也可将 `Content-Type` 设为 `application/json`，正文传经过校验的 Tiptap JSON。`If-Match` 必须是当前版本号。

### 精确编辑正文

优先用以下接口做最小修改，而非整篇替换：

```http
PATCH /etapi/notes/:noteId/content
Content-Type: application/json
```

```json
{
  "expectedVersion": 3,
  "edits": [
    { "oldText": "旧句子", "newText": "新句子" }
  ]
}
```

`oldText` 是大小写和换行均敏感的字面文本，默认必须恰好命中一次。对重复片段，传入 `expectedMatches` 并让它等于预期命中数。多个编辑原子执行；找不到目标、命中数不符或目标重叠会返回 `422 PatchTargetError`，此时重新读取内容后再判断。带 `dryRun: true` 可预览结果。

### 移动 placement

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

移动的是 placement，不是笔记本身。服务端会阻止系统节点修改和层级循环。

## 错误处理

| 状态码 | 应对方式 |
| --- | --- |
| `400` | 修正参数、正文格式或版本头后再执行。 |
| `403` | 请用户在桌面设置中开启 AI 与外部访问，然后重新调用；不需要令牌或重启。只允许本机原生客户端访问。 |
| `404` | 目标不存在；重新读取层级或请用户确认。 |
| `409` | 重新读取最新状态后再决定是否修改，不能盲目重试。 |
| `415` | 正文接口的 `Content-Type` 不受支持。 |
| `422` | 精确编辑未能唯一、完整地定位目标；重新读取后再生成补丁。 |

错误格式为：

```json
{
  "error": {
    "code": "ConflictError",
    "message": "Note changed elsewhere; refresh before saving."
  }
}
```

完整的管理员与本机访问说明见 [`etapi.md`](./etapi.md)。


## 按意图操作

- `get_section` 返回的 content 原样作为章节替换的 oldText，同时使用其 version 和 headingPath。
- 追加使用 `operation: "append"`，标签增删使用 `operation: "tags"`，章节替换使用 `operation: "replace_section"`。
- 创建建议携带 Idempotency-Key，追加必须携带。同一本机数据库及操作范围内，30 天内可以使用相同键和参数重试。带键写入返回最小回执，另行读取正文。
- 追加文本按 Markdown 新块处理；代码为字面字符串，调用方自己提供换行。
- 批量读取和移动逐项报告结果；批量移动不是跨请求事务。
