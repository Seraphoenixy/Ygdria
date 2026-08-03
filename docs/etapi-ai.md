# Ygdria ETAPI：给 AI 的调用说明

你可以通过 Ygdria 桌面应用在本机提供的 ETAPI 读取和编辑笔记。只使用用户明确提供给你的 **ETAPI 短期令牌**；不要索取、保存或尝试使用主密码、设备令牌、`X-Ygdria-Local-Token`，也不要调用 `/api/v1/*`。

## 连接

基础地址固定为：

```text
http://127.0.0.1:4318
```

所有请求都带：

```http
Authorization: Bearer <ETAPI_TOKEN>
```

令牌仅对本机桌面应用有效，具有有限有效期；过期、撤销或桌面应用重启后会失效。令牌只可调用本页列出的 `/etapi/*` 接口。

## 必须遵守的操作规则

1. 除非用户明确要求修改，否则只读，不创建、不编辑、不移动笔记。
2. 编辑已有笔记前，先读取它以获得最新 `version`。
3. `PATCH /etapi/notes/:id` 必须带读取到的 `expectedVersion`。
4. 收到 `409 Conflict` 后，重新读取笔记、基于最新内容重新判断；不要直接重试旧写入。
5. 网络超时后不要自动重试 `POST /etapi/notes`，因为可能已成功创建笔记。先搜索或询问用户。
6. 不要请求、修改或推断受保护笔记。它们不会提供正文，层级中可能仅有脱敏占位。
7. 不要使用删除、清空回收站等未列出的接口；ETAPI 不提供这些能力。

## 权限

| 权限 | 可以做什么 |
| --- | --- |
| `notes:read` | 读取层级、笔记、正文、tag，执行搜索。 |
| `notes:write` | 创建/更新笔记、替换正文、移动 placement。 |

只持有 `notes:write` 时，写入成功响应只包含 `id`、`version`、`updatedAt`；这不是读取正文的替代方式。

## 读取接口

### 获取层级

```http
GET /etapi/tree?includeArchived=false
```

返回扁平 `items` 数组。用 `placementId` 和 `parentPlacementId` 重建层级；同一笔记可有多个 placement，因此不要把 `noteId` 当作树节点 ID。

每项主要字段：

```json
{
  "placementId": "placement-id",
  "noteId": "note-id",
  "parentPlacementId": "parent-placement-id-or-null",
  "position": 0,
  "title": "笔记标题",
  "type": "text",
  "properties": { "tags": ["项目"] },
  "version": 3,
  "updatedAt": "2026-08-04T10:30:00.000Z"
}
```

默认不返回归档笔记或回收站笔记。`includeArchived=true` 可包含归档笔记。

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

二者必须二选一：

```http
GET /etapi/search?q=会议纪要&includeArchived=false
GET /etapi/search?tag=项目&includeArchived=false
GET /etapi/tags
```

搜索响应为 `{ "items": [...] }`；每项含笔记 ID、标题、匹配片段、更新时间和 tag。受保护笔记不会出现在搜索结果中。

## 写入接口

仅在用户明确授权修改时使用，并以最小改动为原则。

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
| `401` | 停止调用，令牌缺失、无效、过期或已撤销；请用户在桌面设置中创建新令牌。 |
| `403` | 停止当前操作；令牌缺少所需权限。不要尝试绕过权限。 |
| `404` | 目标不存在；重新读取层级或请用户确认。 |
| `409` | 重新读取最新状态后再决定是否修改，不能盲目重试。 |
| `415` | 正文接口的 `Content-Type` 不受支持。 |

错误格式为：

```json
{
  "error": {
    "code": "ConflictError",
    "message": "Note changed elsewhere; refresh before saving."
  }
}
```

完整的管理员、安全与令牌管理说明见 [`etapi.md`](./etapi.md)。
