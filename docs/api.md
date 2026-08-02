# API 与内容格式

## 1. REST API

所有应用 API 使用 `/api/v1` 前缀。认证有两层（详见 [认证、受保护笔记与同步边界](auth-and-sync.md)）：

- `X-Ygdria-Local-Token`：本地共享令牌，由 `buildApp({ localToken })` 启用时强制校验；形态 A 默认不设置。
- `Authorization: Bearer <deviceToken>`：独立服务始终启用。`/api/v1/health`、`/api/v1/auth/config`、`/api/v1/devices/initialize`、`/api/v1/auth/login/challenge`、`/api/v1/auth/login/verify`、`/api/v1/devices/pair` 为公开路径，其余 `/api/*` 与 `/etapi/*` 均需设备令牌。设备令牌采用统一的 **主密码派生 + PAKE（SRP-6a）挑战响应** 模型签发，详见 [认证、受保护笔记与同步边界](auth-and-sync.md)。
- `X-Ygdria-Sync-Origin`：可选请求头，仅形态 A（桌面内嵌）有效。值为 `remote` 时，服务端跳过该请求的 `sync_change_log` 写入，避免远端拉取的变更在本地再次产生同步记录形成循环。形态 B 忽略此头部。

主要资源：

| 方法           | 路径                                   | 用途                                        |
| -------------- | -------------------------------------- | ------------------------------------------- |
| `GET`          | `/api/v1/tree`                         | 读取完整 placement 扁平列表，客户端重建树。 |
| `GET`          | `/api/v1/placements/:id/children`      | 按需读取某节点的子 placement。              |
| `GET`          | `/api/v1/placements/:id/size`          | 读取 placement 及其子树的逻辑存储大小（内容字节 + 附件字节）。 |
| `POST`         | `/api/v1/notes`                        | 创建 text 笔记及其第一个 placement。        |
| `POST`         | `/api/v1/notes/today`                  | 在日历路径下创建今日笔记。                  |
| `POST`         | `/api/v1/notes/today/ensure`           | 确保今日日期节点存在并返回该节点本身；不会创建日期节点下的普通子笔记。 |
| `GET/PATCH`    | `/api/v1/notes/:id`                    | 读取、更新笔记。`PATCH` 可提交 `content`（明文 JSON）或 `contentCiphertext`（受保护笔记密文）。 |
| `PATCH`        | `/api/v1/notes/:id/archive`            | 请求 `{ "archived": boolean }` 以归档或取消归档。 |
| `GET`          | `/api/v1/notes/:id/revisions`          | 读取该笔记的正文修订历史。                  |
| `POST`         | `/api/v1/notes/:id/revisions/:revisionId/restore` | 按 `expectedVersion` 恢复正文历史版本。 |
| `POST`         | `/api/v1/revisions/cleanup`            | 裁剪超出保留上限的修订历史；请求体 `{ limit }`，`limit` 为 `-1`（保留全部）或非负整数；返回裁剪结果。 |
| `GET`          | `/api/v1/history?limit=200&includeArchived=false` | 汇总普通与回收站笔记的最近修改记录及根路径；`includeArchived=true` 时包含归档笔记。 |
| `GET`          | `/api/v1/trash/:id`                    | 读取位于回收站中的笔记（只读）。             |
| `DELETE`       | `/api/v1/notes/:id`                    | 将整个笔记实体移入回收站，返回撤销记录 ID。  |
| `POST`         | `/api/v1/notes/:id/restore`            | 恢复该笔记对应的最近一次可撤销删除动作。     |
| `DELETE`       | `/api/v1/notes/:id/permanent`          | 永久删除笔记并触发数据库级联清理，返回 `{ attachmentStorageKeys }`。 |
| `DELETE`       | `/api/v1/trash`                        | 永久删除回收站中所有笔记，返回 `{ count, attachmentStorageKeys }`。 |
| `POST`         | `/api/v1/notes/:id/attachments`        | 上传附件：请求体 `{ filename, dataBase64, mimeType? }`，返回 `{ id, url }`。 |
| `GET`          | `/api/v1/attachments/:id`              | 下载附件文件（字节流，MIME 类型由元数据决定）。 |
| `GET`          | `/api/v1/attachments/by-hash/:hash`    | 按 SHA-256 哈希下载附件字节流（同步专用，去重传输）。 |
| `POST`         | `/api/v1/attachments/by-hash/:hash`    | 按 SHA-256 哈希上传附件字节流（流式请求体，查询参数 `noteId`、`filename`）；已存在时只建立链接并返回 `existed: true`。 |
| `GET`          | `/api/v1/attachments/unused/count`     | 返回未被任何笔记引用的附件数量。 |
| `DELETE`       | `/api/v1/attachments/unused`           | 清除所有未引用附件并执行存储清理，返回 `{ count, attachmentStorageKeys }`。 |
| `GET`          | `/api/v1/attachments`                  | 列出全部附件及其归属笔记与未使用计数，返回 `{ attachments: [{ id, filename, mimeType, size, createdAt, contentHash, referencingNotes: [{ id, title }] }], unusedCount }`；用于附件整理页。 |
| `GET`          | `/api/v1/attachments/by-hash/:hash/exists` | 按 SHA-256 哈希快速判断附件是否已存在，返回 `{ exists: boolean, id: string \| null }`；同步去重时用于避免重复上传。 |
| `GET`          | `/api/v1/relations?noteId=`            | 列出某笔记的出向（source=该笔记）与入向（target=该笔记，即反向链接）关系，返回 `{ outgoing: [...], incoming: [...] }`，每项含 `peerTitle`。 |
| `POST`         | `/api/v1/relations`                    | 创建关系，请求体 `{ sourceNoteId, targetNoteId, relationType }`（`relationType` ∈ `related`/`uses`/`prerequisite`）；重复边返回 `duplicate: true`。自关联、系统笔记端点或不存在的笔记返回 404。 |
| `DELETE`       | `/api/v1/relations/:id`                | 删除关系（由数据库触发器自动写同步墓碑）。 |
| `POST`         | `/api/v1/placements`                   | 新增 placement，用于 clone，返回 `{ id, noteId, parentPlacementId, position }`。 |
| `PATCH/DELETE` | `/api/v1/placements/:id`               | 移动（`PATCH`，返回 `{ ok: true }`）或删除（`DELETE`，返回撤销记录 ID）树中的位置。 |
| `POST`         | `/api/v1/placement-deletions/:id/undo` | 撤销指定 placement 删除。                   |
| `GET`          | `/api/v1/search?q=...&includeArchived=false` | FTS5 全文搜索；`includeArchived=true` 时包含归档笔记。受保护笔记不进 FTS，永远搜不到。 |
| `GET`          | `/api/v1/archived`                     | 按归档时间倒序读取未删除的归档笔记；受保护笔记不在此列表。 |
| `PATCH`        | `/api/v1/notes/:id/protected`          | 启用或关闭单笔记端到端加密。`{ protected: true, contentCiphertext }` 切换为密文态；`{ protected: false, title, content, propertiesJson? }` 还原为明文并重建 FTS。 |
| `GET`          | `/api/v1/protected-session`            | 读取受保护会话配置：`{ configured, salt, verifier, timeoutMs }`。 |
| `POST`         | `/api/v1/protected-session/setup`      | 设置文件主密码盐、校验值与超时；覆盖已有配置。**设备认证模式下必须携带 `auth` 字段**（官方客户端从同一主密码重新派生的 `{ accessSalt, srpSalt, verifier }`），服务端在同一事务中写入文件材料和 SRP 认证记录；因认证记录被替换，全部现有设备令牌会立即撤销。本地桌面模式（无设备认证）保留原行为——可不携带 `auth`。 |
| `POST`         | `/api/v1/protected-session/change-password` | 主密码变更。请求体 `{ salt, verifier, timeoutMs?, notes: [{ id, contentCiphertext, expectedVersion }], auth: { accessSalt, srpSalt, verifier } }`：客户端用旧密码解密全部受保护笔记，用新密码重新加密后随新文件盐/校验值和新 SRP 记录在**单事务**内提交。任一笔记版本冲突则整体回滚。设备认证模式下 `auth` 必填；成功后 `devices.revokeAll()` 连同当前设备一并撤销所有令牌，强制全部客户端用新主密码重新登录。 |
| `POST`         | `/api/v1/protected-session/clear`      | 清除会话配置（不自动解密已加密笔记）。 |
| `PATCH`        | `/api/v1/protected-session`            | 调整自动锁定超时 `{ timeoutMs }`。 |
| `POST`         | `/api/v1/maintenance/database`         | 后台维护任务：修剪 placement 撤销快照 + `VACUUM` + WAL checkpoint（可选 FTS 重建）。立即返回任务 ID；同一时刻只允许一个任务排队或运行（`409`），15 分钟冷却期内返回 `429`。 |
| `GET`          | `/api/v1/maintenance/status`           | 查询当前或最近一次维护任务的状态（`queued` / `running` / `succeeded` / `failed`）与结果摘要。 |
| `POST`         | `/api/v1/maintenance/search-index`     | 后台触发 `notes_fts` 全文索引的完整重建任务，立即返回任务 ID；状态通过 `GET /api/v1/maintenance/status` 查询。 |

请求参数通过 Zod 校验。错误统一为：

```json
{ "error": { "code": "NotFoundError", "message": "Not found" } }
```

`PATCH /api/v1/notes/:id` 必须提交正整数 `expectedVersion`。服务端使用 `WHERE id = ? AND version = ? AND deleted_at IS NULL` 的条件更新，并在同一条 SQL 中递增版本；受影响行数为零时返回 `409 Conflict`，不会静默覆盖其他客户端的保存。ETAPI 的 `PUT /etapi/notes/:id/content` 使用 `If-Match: <version>` 承载同一条件。Web 客户端命中该 `409` 时会弹出保存冲突对话框，展示远端与本地差异供用户选择（见 [架构设计 §4.1.7](architecture.md#417-保存冲突提示)）。

归档不会修改正文、`content_hash`、placement、关系、附件或 revision；重复请求幂等。已删除笔记归档会返回冲突。`GET /api/v1/search` 与 `GET /api/v1/history` 接受 `includeArchived=true`；默认排除未删除的归档笔记，最近修改仍保留回收站记录以支持恢复。

`DELETE /api/v1/placements/:id` 只针对一个树位置；SQLite 会级联移除其 placement 子树，但不会直接永久删除对应 note。`DELETE /api/v1/notes/:id` 则会移除该实体的全部 placement（包括 clone 位置及其子树）。两种删除都会先写入完整 placement 快照，再将失去全部位置的笔记移入回收站，并返回 `{ "undoId": "..." }`。`POST /api/v1/placement-deletions/:undoId/undo` 可独立撤销任一尚未使用的删除记录；`POST /api/v1/notes/:id/restore` 会找到该回收站笔记最近一次仍可用的删除记录并执行相同恢复，返回 `{ undoId }`。若原父位置已不存在，则恢复到固定根节点。`DELETE /api/v1/notes/:id/permanent` 的响应包含本次永久删除后已无引用附件的 `attachmentStorageKeys`，附件存储适配器应使用这些键删除物理文件。`DELETE /api/v1/trash` 永久清空回收站中所有笔记，返回 `{ count, attachmentStorageKeys }`。

恢复 revision 使用 `POST /api/v1/notes/:noteId/revisions/:revisionId/restore`，请求体为 `{ "expectedVersion": number }`。它与普通正文保存使用相同的乐观并发控制：恢复前会把当前正文写为一条新 revision，再恢复目标正文、更新 FTS 并递增版本；版本过期时返回 `409 Conflict`。

受保护笔记的响应形状不同：`GET /api/v1/notes/:id` 与 `GET /api/v1/trash/:id` 在 `isProtected=true` 时返回 `title=""`、`content=null`，并额外提供 `contentCiphertext`（服务端从 `content_data` 解码 `ciphertext-v1` 后原样返回密文，由客户端用本地派生密钥解密）。`GET /api/v1/tree` 仍包含受保护笔记的位置，但标题为空，由前端在解锁后本地解密显示。受保护笔记不创建 revision，因此 `GET /api/v1/notes/:id/revisions` 返回空数组。完整加密模型见 [auth-and-sync.md](auth-and-sync.md#4-受保护笔记端到端加密)。

普通笔记的响应中 `content` 字段是服务端从 `content_data` 按 `content_codec`（`identity` 或 `zstd-v1`）解码后再 `JSON.parse` 得到的 Tiptap JSON 对象；`content_codec` 与 `content_size` 不暴露在 REST 响应中，仅在增量同步的变更记录 `data` 字段里随 `contentData` 一并传输。

## 1.1 设备管理与认证

独立服务始终启用；认证与配对流程的信任模型见 [auth-and-sync.md](auth-and-sync.md#3-统一主密码模型)。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/v1/health` | 公开。返回 `{ status, bootstrapped, requiresDeviceAuth, authInitialized }`。`authInitialized` 反映是否已设置主密码（即 `auth_srp_verifier` 是否存在）。 |
| `GET` | `/api/v1/ready` | 公开、不限速。负载均衡/编排器探活专用：SQLite `SELECT 1` 与附件目录可创建均通过时返回 `200 { status: "ok" }`；任一失败返回 `503 { status: "unavailable" }`，不暴露内部错误细节。 |
| `GET` | `/api/v1/auth/config` | 公开。返回认证参数。未初始化时返回 `{ initialized: false, protocolVersion, kdfVersion, pbkdf2Iterations }`；已初始化时返回 `{ initialized: true, protocolVersion, kdfVersion, pbkdf2Iterations, accessSalt, srpSalt, accessSecretContext, srpUsername }`。`accessSalt` 与 `srpSalt` 是公开的派生参数；`verifier` **永远不返回**，避免攻击者离线重放 SRP。 |
| `POST` | `/api/v1/devices/initialize` | 公开且仅可成功一次。客户端本地从主密码 + `accessSalt` 派生 `accessSecret`，再运行 SRP-6a 注册生成 `{ srpSalt, verifier }`；同时从**同一主密码**派生文件密钥并生成文件盐 + 文件 verifier（`fileSalt`、`fileVerifier`）。提交：`{ accessSalt, srpSalt, verifier, fileSalt, fileVerifier, label }`。服务端在**同一事务**中写入 SRP 认证记录（盐、验证器、协议/KDF 版本）**和**受保护会话文件记录（`protected_session_salt`、`protected_session_verifier`、`protected_session_timeout_ms` 默认 600 000），并清理旧的 `server_access_password_*` 遗留记录，然后返回第一台设备的 `{ deviceId, deviceToken }`。服务端不持有主密码，无法独立证明两套记录同源；官方客户端负责从同一主密码派生并原子提交它们。重复初始化返回 `409`。 |
| `POST` | `/api/v1/auth/login/challenge` | 公开。提交 `{ clientPublicEphemeral }`（客户端临时公钥）。服务端基于已保存的 `verifier` 生成一次性临时密钥对，返回 `{ challengeId, srpSalt, serverPublicEphemeral }`。`challengeId` 单次有效且短时存活；重放同一 `challengeId` 在 `verify` 阶段找不到任何记录。失败时不区分“未初始化”/“格式错误”/“verifier 损坏”，统一返回 `401`。 |
| `POST` | `/api/v1/auth/login/verify` | 公开。提交 `{ challengeId, clientPublicEphemeral, clientSessionProof, label }`。服务端派生共享会话密钥并校验 `clientSessionProof`：成功则签发新的 `{ deviceId, deviceToken, serverSessionProof }`；客户端**必须**用 `serverSessionProof` 执行互证以避免恶意服务端。失败统一返回 `401`，且与 `challenge` 端点共享同一来源 IP 的失败计数：连续失败 5 次后暂停该 IP 登录 30 秒，期间返回 `429`。 |
| `POST` | `/api/v1/devices/pair` | 公开。提交 `{ pairingToken, label }` 消费一次性配对令牌，返回 `{ deviceId, deviceToken }`（`deviceToken` 仅此一次可见）。 |
| `GET` | `/api/v1/devices` | 需设备令牌。列出已配对设备（不含令牌哈希）。 |
| `GET` | `/api/v1/devices/me` | 需设备令牌。返回当前令牌对应的设备。 |
| `POST` | `/api/v1/devices/pairing-token` | 需设备令牌。签发新的配对令牌，供另一台设备配对。 |
| `DELETE` | `/api/v1/devices/:id` | 需设备令牌。撤销指定设备，令牌立即失效。 |
| `POST` | `/api/v1/devices/revoke-all` | 需设备令牌。撤销除当前设备外的全部设备，返回撤销数量。注意：主密码改密端点（见下文）调用的是内部 `revokeAll`，会**连同当前设备一并撤销**，强制所有客户端用新主密码重新认证。 |

主密码长度限制为 8–64 个 UTF-16 代码单元（`MIN_MASTER_PASSWORD_LENGTH` / `MAX_MASTER_PASSWORD_LENGTH`），在客户端派生 `accessSecret` 与 `fileKey` 时分别校验。服务端**只保存**：`accessSalt`、`srpSalt`、SRP-6a `verifier`、协议版本（`auth_protocol_version`，当前 `srp6a-v1`）、KDF 版本（`auth_kdf_version`，当前 `pbkdf2-sha256-v1`）、PBKDF2 迭代次数（`auth_pbkdf2_iterations`，600 000）以及上下文/用户名常量。**绝不保存**：主密码明文、派生得到的 `fileKey`、`accessSecret`、可直接重放的固定哈希或 `deviceToken` 明文——`deviceToken` 仅在签发时返回一次，服务端内存中只保留其 `sha256` 哈希。

设备令牌仅在服务器进程内存中存活，**不持久化**；服务器重启后全部失效，客户端需再次用主密码走 SRP 登录取得新令牌。此外，设备令牌采用固定的 **5 天滑动闲置超时**（`DEVICE_TOKEN_IDLE_TIMEOUT_MS = 5 * 24 * 60 * 60 * 1000`）：每次成功调用受保护端点会刷新 `lastActiveAt`；超过 5 天未活动的令牌会在下一次校验时被立即删除并返回 `401`，记录同时被回收。该超时不可配置。

认证相关错误码映射：

| 状态码 | `code` / `message` | 触发场景 | 备注 |
| --- | --- | --- | --- |
| `400` | `clientPublicEphemeral is required` 等 | `challenge` / `verify` / `initialize` 缺字段 | 请求体校验失败 |
| `401` | `Authentication failed` | SRP 校验失败、verifier 损坏、challengeId 重放/过期、未初始化时尝试登录 | **故意不区分原因**，避免泄露用户枚举或 verifier 状态 |
| `401` | `Missing device token` / `Invalid device token` | 受保护端点缺失或无效 `Bearer` 令牌 | 无效令牌包括 5 天闲置超时被回收的记录 |
| `403` | `Device auth is not enabled on this server` | 形态 A 未启用设备认证时调用 `/auth/*` | 形态 B 不会触发 |
| `409` | `Master password is already configured` | 重复 `initialize` | 一次性初始化保护 |
| `401` | `Authentication failed` | 未初始化时调用 `challenge` | 与其他登录失败统一，初始化状态应通过 `/auth/config` 获取 |
| `429` | `Too many failed login attempts; try again later` | 同一来源 IP 连续失败 5 次 | 暂停 30 秒，期间 `challenge` 与 `verify` 均返回 `429` |

## 1.2 增量同步

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/v1/sync/changes?cursor=&limit=` | 拉取自 `cursor` 之后的变更记录；返回 `{ cursor, hasMore, changes, maxChangeId }`。 |
| `POST` | `/api/v1/sync/push` | 提交变更列表 `{ changes: [...] }`；按 last-write-wins 合并，返回 `{ applied }`。 |
| `POST` | `/api/v1/sync/advance` | 提交 `{ peerId, cursor }` 推进指定 peer 的游标。 |
| `GET` | `/api/v1/sync/cursor?peerId=` | 读取指定 peer 的游标 `{ peerId, lastAdvanceId, advancedAt }`；不存在时 `lastAdvanceId: 0`。 |
| `GET`          | `/api/v1/sync/snapshot?cursor=&limit=&metadataOnly=` | 全量状态快照，作为增量日志被修剪后的兜底基线；按 `cursor` 分页（`limit` 1–500，默认 200），`metadataOnly=1` 时仅返回元数据不含实体正文；返回 `{ cursor, hasMore, changes, maxChangeId }`。 |
| `GET`          | `/api/v1/sync/notes/:id/content?hash=` | 拉取单条笔记正文（同步专用）；`hash` 命中不一致时返回 `404`。返回 `{ contentData(base64), contentCodec, contentSize, contentHash, plainText }`。另有 `GET /api/v1/sync/notes/:id/content/blob` 支持 `Range` 分块下载（`206` + `ETag`），用于大正文。 |
| `POST`         | `/api/v1/sync/rebuild`                 | 为新初始化的 peer 重建同步基线（用于迁移到增量日志已被修剪的空白服务器）；无请求体，返回基线游标信息。 |

以上同步端点（含 `snapshot` / `notes/:id/content` / `rebuild`）均属于受保护 API（需设备令牌）。变更记录结构为 `{ changeId, entityType, entityId, changeKind, createdAt, data }`，`entityType` 覆盖 `note` / `placement` / `relation` / `revision` / `attachment` / `setting` / `placement_deletion`；`changeKind` 为 `created` / `updated` / `deleted`；`data` 在删除时为 `null`，否则为实体快照。附件文件二进制**不进变更日志**，客户端根据 `attachment.data.contentHash` 调用 `GET /api/v1/attachments/by-hash/:hash` 下载、`POST /api/v1/attachments/by-hash/:hash` 上传，按哈希去重。

`push` 按 `updatedAt` / `createdAt` 时间戳逐记录合并；同一时间戳冲突时按确定性 JSON 序列化顺序选择。`sync_tombstones` 表用于过滤已删除实体，避免旧变更复活数据。**敏感设置不参与同步**：`auth_*`、`protected_session_*`、`server_access_password_*` 前缀的 settings 键既不出现在 `/sync/changes` 的返回中，也无法通过 `/sync/push` 修改——这些键只能通过 `/devices/initialize`、`/protected-session/setup`、`/protected-session/change-password` 等专用端点变更。这避免任何已认证设备通过同步通道覆盖认证材料导致账户接管。

每个 peer 在 `sync_cursors` 表中维护独立的游标记录，游标为 `0` 表示无历史同步。客户端首次同步应从 0 开始拉取全量变更日志作为基线。

当增量变更日志因过期被 `pruneChangeLog` 修剪、无法从旧游标补拉时，`GET /api/v1/sync/snapshot` 提供全量状态快照作为兜底基线（按 `cursor` 分页，可选 `metadataOnly` 仅取元数据）；迁移到一处增量日志已被清空的空白服务器时，客户端应先调用 `POST /api/v1/sync/rebuild` 重建基线游标，再从 `0` 重新拉取。

## 1.3 健康检查与就绪探针

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/v1/health` | 公开、不限速。返回 `{ status, bootstrapped, requiresDeviceAuth, authInitialized }`。`authInitialized` 反映是否已设置主密码。 |
| `GET` | `/api/v1/ready` | 公开、不限速，供负载均衡/编排器探活。SQLite `SELECT 1` 与附件目录可创建均通过时返回 `200 { status: "ok" }`；否则 `503 { status: "unavailable" }`，**不暴露内部错误细节**。 |

## 2. ETAPI

ETAPI 面向导入导出、自动化和外部脚本。正文接口：

```text
GET /etapi/notes/:id/content?format=markdown   默认
GET /etapi/notes/:id/content?format=json
GET /etapi/notes/:id/content?format=html
PUT /etapi/notes/:id/content
```

`PUT` 的 `Content-Type: text/markdown` 会走：Markdown 解析 → Tiptap JSON Schema → 纯文本提取 → 修订 + FTS 更新。`Content-Type: application/json` 接受经过校验的 Tiptap JSON。

ZIP 导入在客户端解压：子目录会转换为笔记层级，Markdown 文件成为对应子笔记。Markdown 的相对图片引用会上传为该笔记附件，并改写为 `/api/v1/attachments/:id` URL。附件写入使用 `POST /api/v1/notes/:id/attachments`，请求体为文件名和 Base64 数据；`GET /api/v1/attachments/:id` 返回附件字节流。

## 3. Markdown 约定

正文内部不是 Markdown，而是 Tiptap/ProseMirror JSON。Markdown 是可迁移交换格式。

- 笔记引用：`[[note:NOTE_ID|显示标题]]`
- 预留嵌入：`![[note:NOTE_ID]]`
- YAML Front Matter 映射到属性，而不是正文段落。
- 普通表格使用 GFM；合并单元格、复杂列宽等 GFM 无法表达的表格降级为 HTML `<table>`，并应产生转换警告。
