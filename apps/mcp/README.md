# Ygdria MCP Server

本机 MCP ↔ Ygdria ETAPI 适配器。无需令牌，也无需单独开启 MCP 写权限；访问由 Ygdria 桌面应用中的一个开关控制。

## 使用

1. 在 Ygdria 桌面设置中开启 **AI 与外部访问 → 允许本机工具访问**。
2. 安装并构建本项目：

```powershell
npm install
npm run build
```

3. 在 MCP 客户端配置本地 stdio 服务，例如：

```json
{
  "mcpServers": {
    "ygdria": {
      "command": "node",
      "args": ["D:\\projects\\Ygdria-MCP\\dist\\index.js"]
    }
  }
}
```

默认连接 `http://127.0.0.1:4318`。直接 `npm start` 可启动 stdio 服务；stdout 只用于 MCP 消息。需要 Node.js 18 或更高版本和正在运行的 Ygdria Desktop。

关闭桌面开关会立即阻止后续调用；重新开启后直接继续调用，无需重启 MCP。首次从旧版本升级仍需重启主服务和 MCP 以加载新实现。

## 可选配置

通常不需要配置文件。自定义本机端口时，可填写 `ygdria-mcp.ini`：

```ini
[etapi]
url = http://127.0.0.1:4318
```

也可用 `YGDRIA_ETAPI_URL` 覆盖地址，`YGDRIA_CONFIG_FILE` 指定配置文件。地址必须是 HTTP(S) loopback origin，不能包含路径、凭据或远程主机。修改地址需重启。

旧 token、allowWrite 以及对应环境变量不再使用，可从配置中删除；不会发送旧令牌。MCP 自动添加 `X-Ygdria-External-Access: 1`，拒绝跟随 HTTP 重定向。Ygdria 另外校验 socket、Host 和浏览器请求头；桌面私有 API 仍受独立凭据保护。

## 工具

| 工具 | 用途 |
| --- | --- |
| `search_notes` / `search_by_tag` / `list_tags` | 关键词、标签、目录组合搜索与标签统计。 |
| `list_tree_roots` / `get_tree_node` / `list_tree_children` | 分页浏览 placement。 |
| `get_tree_subtree` / `resolve_tree_nodes` | 有界子树和按名称定位。 |
| `get_tree_overview` | 自动分页展开；限制节点、深度、条目字节数和请求数，返回截断状态及续读位置。 |
| `get_note` / `get_notes` | 单篇或最多 50 篇批量读取；批量支持 metadata、excerpt、full。 |
| `get_section` | 按标题祖先路径读取唯一章节的正文和版本。 |
| `create_note` | 在任务授权范围内创建，支持幂等键。 |
| `update_note` / `replace_content` | 带版本更新元数据或正文。 |
| `edit_content` | oldText/newText 字面精确编辑；支持预览。 |
| `append_content` | 追加 Markdown 块或字面代码；必须带幂等键。 |
| `update_tags` | 增删指定标签并保留其他标签，超限报错。 |
| `replace_section` | 用 get_section 返回的正文和版本替换章节，保留标题和章节外节点。 |
| `move_placement` / `move_placements` | 单个或最多 50 个顺序批量移动，逐项报告结果。 |

所有工具始终注册，执行权限由桌面开关决定。用户已授权的任务可连续完成必要操作，无需每步重复确认；MCP 客户端自身的确认策略仍由客户端决定。受保护笔记、系统节点保护和正文乐观并发继续有效。

笔记 Resource 为 `ygdria://note/{noteId}`，返回 Markdown 和版本标记。树节点使用 placementId，笔记使用 noteId。

目录概览的字节预算约束 items，续读元数据另计。continuation 原样传入下一次调用，并保持 maxDepth/includeArchived 一致；遍历不是快照，结构变化时可能需要重新开始。指定 placement 时返回其后代。深度未展开节点单独列出。

批量读取超过预算返回 remainingNoteIds，单篇过大时改用 excerpt 或 get_note。批量移动允许部分成功，不构成跨请求事务；遇到访问被关闭时停止。

创建建议使用 idempotencyKey，追加必须使用。同一本机数据库和操作目标下，30 天内使用相同键和相同参数可安全重试；不同参数复用键返回 409。带键写入返回 `{ id, version, updatedAt }` 原始回执，正文另行读取。回执由主服务同事务持久保存，关闭/开启开关和重启不会改变其身份；恢复旧数据库备份或超过 30 天后不保证去重。未带键的创建不能盲目重试。

错误返回可解析 JSON，包含状态、业务详情及下一步操作；5xx 隐藏内部详情。403 时先检查桌面开关和本机连接条件。409 重新读取内容后判断，不覆盖新版本；422 修正精确编辑目标，不自动模糊替换。

## 验证

```powershell
npm run typecheck
npm test
```
