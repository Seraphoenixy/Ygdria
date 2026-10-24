# MCP 重排后的缓存与同步修复

用户报告 MCP 重排后树未刷新，且远端 POST /api/v1/sync/push 返回 500。

- 本机数据库 readonly quick_check 正常、foreign_key_check 为空，出站游标停在 1018；重排日志为 1019–1070。
- 回归测试复现：新建父目录、移入子节点、最后重排父目录，coalesced 日志中子节点早于新父节点；原接收顺序只按 entityType 排序，SQLite 外键错误。
- 经 MCP 将待办笔记在原父节点原 position 重新记录一次，使父 placement 的最新记录早于子 placement；未改可见结构和正文。随后上传游标推进到 1072，下载游标也前进，确认当前队列恢复。
- 永久修复：shared/orderSyncChanges 在发送拆包前及接收应用前按同批次父子依赖排序；不改变日志或游标。新增 tree/version 高水位与 UI 独立观察，避免远端同步失败阻塞外部修改刷新；编辑时延后笔记正文刷新。
