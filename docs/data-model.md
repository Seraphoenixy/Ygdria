# 数据结构与存储设计

## 1. 概览

Ygdria 采用 SQLite。当前运行模型有 10 张由 Drizzle Schema 定义的普通业务表与 1 张 FTS5 虚拟表：`notes`、`settings`、`placements`、`relations`、`revisions`、`attachments`、`storage_cleanup_jobs`、`placement_deletions`、`sync_cursors`、`sync_change_log`；另有 `sync_tombstones` 由迁移 SQL（`CREATE TABLE IF NOT EXISTS`）直接创建，不属于 Drizzle 业务表（见 §3）；FTS 虚拟表为 `notes_fts`。

时间均以 Unix epoch 毫秒（`INTEGER`）保存；对外 API 转换为 ISO 8601 字符串。所有业务 ID 使用 UUID（`TEXT`）。

```text
notes（笔记内容与属性）
  ├── placements  笔记在树中的一个或多个位置
  ├── relations   笔记之间的有类型关系
  ├── revisions   正文历史快照
  └── attachments 共享附件实体与物理文件（引用嵌入在正文 JSON 中）

settings          知识库级配置
sync_cursors      同步 peer 游标维护
sync_tombstones   同步删除墓碑（让对端区分"未创建"与"已删除"）
notes_fts         从 notes 投影出的全文搜索索引（external-content FTS5）
```

正文存储采用 **BLOB + codec** 模型：`notes.content_data` 是字节流，`content_codec` 标识如何解码（`identity` = 原 UTF-8 JSON；`zstd-v1` = zstd 压缩的 UTF-8 JSON，≥2 KiB 时按压缩率自动启用；`ciphertext-v1` = 受保护笔记的密文 UTF-8 字符串）。`revisions.content_data` 同样是 BLOB + codec（仅 `identity` / `zstd-v1`，不会保存密文，因为受保护笔记不创建 revision）。`content_size` 始终保存**未压缩**的字节长度，用于存储占用量统计。这种分离让大正文能透明压缩而不影响 `content_hash` 与逻辑等价性。

正文、缓存和灵活属性聚合在 `notes` 中；树位置和笔记关系则独立建表，以支持 clone（同一笔记显示在多个树位置）与双向关系查询。

## 2. 系统记录与核心不变量

数据库初始化会额外创建固定系统记录：根笔记/位置（`...0001` / `...0002`）、回收站笔记/位置（`...0003` / `...0004`）和日历笔记/位置（`...0005` / `...0006`）。根位置是树中唯一允许没有父位置的记录；回收站和日历是根的系统子树；所有普通位置都是根的后代。

- `notes` 是笔记实体；`placements` 是笔记在树中的位置，因此 clone 不复制正文。
- `notes_fts`、`plain_text` 是从权威正文派生的投影，可重建。
- 附件引用嵌入在笔记正文（Tiptap JSON）中，通过 `attachments.id` 关联；物理文件可被多个笔记共享，不随单一笔记删除。
- 系统根、回收站和日历不能作为普通笔记操作的对象。

## 3. 表定义

### `notes`

笔记实体，也是领域聚合根。

| 字段              | SQLite 类型 / 约束                         | 含义                                                                                    |
| ----------------- | ------------------------------------------ | --------------------------------------------------------------------------------------- |
| `id`              | `TEXT PRIMARY KEY`                         | 笔记 UUID。内部引用（例如编辑器中的笔记链接）使用此稳定 ID。                            |
| `title`           | `TEXT NOT NULL`                            | 显示标题；不要求唯一，移动或改名不会影响引用。                                          |
| `type`            | `TEXT NOT NULL DEFAULT 'text' CHECK (...)` | 笔记类型，只允许 `text`、`code`，避免拼写或大小写不一致。                       |
| `content_data`    | `BLOB NOT NULL`                            | 正文字节流，是正文的权威存储。`content_codec` 决定如何解码为 Tiptap JSON 或受保护笔记密文。 |
| `content_codec`   | `TEXT NOT NULL CHECK (...)`                | 内容编码：`identity`（UTF-8 JSON 原文）、`zstd-v1`（zstd 压缩的 UTF-8 JSON，≥2 KiB 时按压缩率自动启用）、`ciphertext-v1`（受保护笔记的密文 UTF-8 字符串，**永不压缩**）。 |
| `content_size`    | `INTEGER NOT NULL`                         | **未压缩**的正文字节长度，用于存储占用量统计与 `sizeForPlacement`。                    |
| `content_hash`    | `TEXT NOT NULL`                            | 解码后的 Tiptap JSON（或受保护笔记密文）经过稳定 JSON 序列化后得到的 SHA-256。用于识别正文是否真的变化。 |
| `plain_text`      | `TEXT NOT NULL`                            | 从正文 JSON 提取的纯文本，用于搜索和摘要。受保护笔记此列为空字符串。                    |
| `is_protected`    | `INTEGER NOT NULL DEFAULT 0`               | 是否为受保护笔记（端到端加密）。为 `1` 时 `content_data` 存的是 `ciphertext-v1` 编码的客户端密文，`title`、`plain_text`、`properties_json` 被清空，服务端无法解密。详见 [auth-and-sync.md](auth-and-sync.md#4-受保护笔记端到端加密)。 |
| `properties_json` | `TEXT NOT NULL DEFAULT '{}'`               | 笔记自定义属性对象，例如标签、来源、状态等。受保护笔记此列为 `"{}"`。                   |
| `version`         | `INTEGER NOT NULL DEFAULT 1`               | 乐观并发版本号。保存请求必须提交 `expectedVersion`；条件更新成功时在同一条 SQL 中递增。 |
| `deleted_at`      | `INTEGER`，可空                            | 笔记实体进入回收站的时间；`NULL` 表示正常笔记。它不表示某一个 placement 被移除。        |
| `archived_at`     | `INTEGER`，可空                            | 笔记归档时间；归档不删除正文、placement、关系、修订或附件。                            |
| `created_at`      | `INTEGER NOT NULL`                         | 创建时间。                                                                              |
| `updated_at`      | `INTEGER NOT NULL`                         | note 自身内容或元数据最后变化时间；不表示树结构、关系、修订或派生数据更新时间。         |

`content_hash` 相同的自动保存不会更新正文、创建 revision、更新 FTS 或递增 `version`。仅标题改变时，仍会更新标题、时间、版本和搜索索引。

新建数据库使用 `CHECK` 限制 `type`；为兼容已经存在的 SQLite 表，启动迁移还会安装等价的插入/更新触发器。历史 `script` 类型会迁移为 `code`，因为它不具备独立的存储或执行语义。

`notes.updated_at` 的正式语义是“note 实体自身内容或元数据的最后变化时间”。正文、标题、`type`、`properties_json` 与 `deleted_at`（移入或恢复回收站）变化时必须更新它；placement 的移动或 clone、relation 的增删、revision 的创建、Markdown 缓存重建与 FTS 重建都不得更新它。附件是独立实体，也不更新该字段；其时间由 `attachments.created_at` 表示。`placements.updated_at` 只描述该树位置自身的移动或排序变化。

归档与删除是独立状态。归档只切换 `archived_at`，更新 `updated_at` 并递增 `version`；不创建正文 revision，也不改变 `content_hash`。已删除笔记必须先恢复才能切换归档状态；恢复删除会保留原有归档状态。FTS 保留归档笔记投影，查询时按状态过滤。

### `settings`

知识库级配置。采用键值形式，避免在每一条笔记中重复保存全局配置。

| 字段         | SQLite 类型 / 约束 | 含义                                             |
| ------------ | ------------------ | ------------------------------------------------ |
| `key`        | `TEXT PRIMARY KEY` | 配置键名。                                       |
| `value`      | `TEXT NOT NULL`    | 配置值，以字符串保存；复杂值可使用 JSON 字符串。 |
| `updated_at` | `INTEGER NOT NULL` | 该配置最后更新时间。                             |

当前初始化的配置是 `content_schema_version = '1'`，表示整个知识库使用的 Tiptap/ProseMirror 正文 Schema 版本。Schema 升级应先迁移全部 `notes.content_data` 与 `revisions.content_data`（按各自 `content_codec` 解码后转换），全部成功后再更新此值。

受保护会话也使用 `settings` 表存储以下键（由客户端 `setup` 写入，`clear` 删除；详见 [auth-and-sync.md](auth-and-sync.md#43-受保护会话-1)）：

| 键 | 含义 |
| --- | --- |
| `protected_session_salt` | PBKDF2 派生密钥用的盐（base64url）。 |
| `protected_session_verifier` | 用派生密钥加密固定明文得到的校验值，用于在不发送密码的前提下验证主密码。 |
| `protected_session_timeout_ms` | 客户端自动锁定超时（毫秒），默认 `600000`（10 分钟），最小 `60000`（1 分钟）。 |

这些键不含主密码或密钥本身；服务端无法据此解密任何受保护笔记。在设备认证模式下，`protected_session_salt`、`protected_session_verifier` 和 `protected_session_timeout_ms` 由 `POST /api/v1/devices/initialize` 在首次初始化时与 SRP 认证记录在**同一事务**中写入。官方客户端从同一主密码派生两套记录；服务端不持有主密码，无法独立证明两套记录同源。

### 设备认证材料（统一主密码派生 + PAKE/SRP-6a）

设备认证也使用 `settings` 表存储以下键，由 `POST /api/v1/devices/initialize` 一次性写入，由 `POST /api/v1/protected-session/change-password` 在主密码改密时原子迁移（详见 [auth-and-sync.md](auth-and-sync.md#3-统一主密码模型)）：

| 键 | 含义 |
| --- | --- |
| `auth_access_salt` | accessSecret 派生路径的随机盐（base64url，16 字节）。客户端用 `PBKDF2(masterPassword + "ygdria/v1/access-secret", accessSalt)` 派生 `accessSecret`，再把它作为 SRP-6a 的“密码”。 |
| `auth_srp_salt` | SRP-6a 注册阶段生成的盐（base64url）。 |
| `auth_srp_verifier` | SRP-6a 验证器（base64url）。服务端用它生成挑战并校验客户端证明；**不可逆推主密码**。 |
| `auth_protocol_version` | PAKE 协议版本，当前固定为 `srp6a-v1`，用于未来迁移识别。 |
| `auth_kdf_version` | KDF 算法版本，当前固定为 `pbkdf2-sha256-v1`。 |
| `auth_pbkdf2_iterations` | PBKDF2-SHA256 迭代次数，当前固定为 `600000`。 |
| `auth_access_secret_context` | accessSecret 派生路径的上下文字符串，当前固定为 `ygdria/v1/access-secret`，用于域分离。 |
| `auth_srp_username` | SRP-6a 的固定“用户名”（`I`），当前固定为 `ygdria`；单用户应用 + 部署级随机盐已使每个 verifier 唯一。 |

这些键同样只保存派生与验证所需的公开参数；**绝不存储**主密码明文、派生的 `fileKey` 或 `accessSecret`，也不存储可直接重放的固定哈希。`deviceToken` 明文不进入数据库——服务端进程内存中只保留 `sha256(deviceToken)`。`auth_srp_verifier` 是否存在（`SELECT 1 FROM settings WHERE key='auth_srp_verifier'`）作为 `isAuthInitialized` 的判据，由 `/api/v1/health` 与 `/api/v1/auth/config` 暴露为 `authInitialized` / `initialized`。

初始化时还会在同一事务中删除旧模型的遗留记录 `server_access_password_salt` 和 `server_access_password_hash`，确保从“独立服务访问密码 + 明文密码登录”到“统一主密码派生 + PAKE 挑战响应”迁移后不留可被重放的旧哈希。

### `placements`

树形界面中的位置，和笔记内容分离。同一 `note_id` 可拥有多个 placement，从而实现 clone。

| 字段                  | SQLite 类型 / 约束                                     | 含义                                                                           |
| --------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `id`                  | `TEXT PRIMARY KEY`                                     | placement UUID。                                                               |
| `note_id`             | `TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE` | 此位置所展示的笔记。永久删除笔记时自动删除它的所有位置。                       |
| `parent_placement_id` | `TEXT REFERENCES placements(id) ON DELETE CASCADE`     | 父位置。只有固定根位置的值为 `NULL`；删除一个位置会级联删除其 placement 子树。 |
| `position`            | `INTEGER NOT NULL`                                     | 同一父节点下的排序值。新增节点取当前最大值加一；移动时由客户端指定目标排序值。 |
| `created_at`          | `INTEGER NOT NULL`                                     | 创建时间。                                                                     |
| `updated_at`          | `INTEGER NOT NULL`                                     | 最后变化时间（位置移动或排序变化）。                                           |

索引：`placements_parent_idx(parent_placement_id, position)` 用于加载子节点；`placements_note_idx(note_id)` 用于查找笔记所有位置。数据库触发器会拒绝普通位置的空父节点，并阻止根位置被移动。初始化旧数据库时，原先所有 `NULL` 父节点都会自动挂到固定根位置下。树的展开状态属于客户端状态，不写入数据库。

树结构不变量：除固定根位置外，每个 placement 必须有父位置；`parent_placement_id` 不能等于自身（SQLite `CHECK`）；任意 placement 不能经父链回到自身（SQLite 更新触发器与领域服务递归 CTE 同时检查）。移动操作在同一 SQLite 事务中验证新父节点存在、不是自身且不是当前节点后代，再写入位置。因此这不是仅靠界面的约定。

### `relations`

笔记之间的有类型连接。它不同于树结构：树关系由 `placements` 表示，`relations` 表示“相关”“依赖”“引用”等知识关系。

| 字段             | SQLite 类型 / 约束                                     | 含义                                               |
| ---------------- | ------------------------------------------------------ | -------------------------------------------------- |
| `id`             | `TEXT PRIMARY KEY`                                     | relation UUID。                                    |
| `source_note_id` | `TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE` | 关系发起方笔记。永久删除任一端时关系自动删除。     |
| `relation_type`  | `TEXT NOT NULL`                                        | 关系类型，例如 `related`、`uses`、`prerequisite`。 |
| `target_note_id` | `TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE` | 关系目标笔记。永久删除任一端时关系自动删除。       |
| `created_at`     | `INTEGER NOT NULL`                                     | 关系创建时间。                                     |

唯一索引 `relations_unique(source_note_id, relation_type, target_note_id)` 防止重复关系；`relations_target_idx(target_note_id)` 支持反向查询“哪些笔记指向我”。

> **同步状态（2026-08-02 起已实现）**：`relations` 现已接入增量同步协议。领域层 `RelationService` 在创建/删除时写入 `sync_change_log`（`entity_type='relation'`），删除由 `sync_tombstone_relation_delete` 触发器自动写墓碑。接收端 `applySyncChanges` 对 `relation` 分支使用 `INSERT OR IGNORE` 保证幂等，并通过 `NOT EXISTS sync_tombstones(entity_type='relation' AND deleted_at >= created_at)` 防止已删除关系的“复活”（与 `setting` 分支同构）。快照 `fullSnapshotChanges` 与基线重建 `rebuildSyncBaseline` 均已包含 relations。关系无 `updated_at`，语义不可变，因此 upsert 不更新时间戳。系统笔记（根、回收站、日历）不得作为关系端点。

### `revisions`

正文变化前的不可变快照。首版保存完整 JSON，而不是差异（diff），读取和恢复更直接。

| 字段            | SQLite 类型 / 约束                                     | 含义                                                               |
| --------------- | ------------------------------------------------------ | ------------------------------------------------------------------ |
| `id`            | `TEXT PRIMARY KEY`                                     | revision UUID；每条历史记录自己的 ID。                             |
| `note_id`       | `TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE` | 此快照所属笔记；一个笔记可有多条历史，永久删除笔记时快照自动删除。 |
| `content_data`  | `BLOB NOT NULL`                                        | 保存前的正文字节流（与 `notes.content_data` 同样的 BLOB + codec 模型）。 |
| `content_codec` | `TEXT NOT NULL CHECK (...)`                            | 内容编码，仅允许 `identity` 或 `zstd-v1`（受保护笔记不创建 revision，因此不会出现 `ciphertext-v1`）。 |
| `content_hash`  | `TEXT NOT NULL`                                        | 该快照正文的稳定 SHA-256，用于校验完整性和识别重复内容。           |
| `created_at`    | `INTEGER NOT NULL`                                     | 创建快照的时间。                                                   |

`revisions_note_idx(note_id, created_at)` 用于按时间读取某篇笔记的版本历史。新模型不再保存 `schema_version` 或 `reason`；已有数据库的这两个旧列只作为兼容遗留列保留。

### `attachments`

附件实体的元数据；一个附件对应一份受控物理文件，可由多个笔记共享引用。二进制文件不直接存入正文 JSON 或 SQLite BLOB。

| 字段           | SQLite 类型 / 约束     | 含义                                                                                 |
| -------------- | ---------------------- | ------------------------------------------------------------------------------------ |
| `id`           | `TEXT PRIMARY KEY`     | 附件 UUID。                                                                          |
| `filename`     | `TEXT NOT NULL`        | 用户可见的原始文件名。                                                               |
| `mime_type`    | `TEXT NOT NULL`        | MIME 类型，例如 `image/png`。                                                        |
| `size`         | `INTEGER NOT NULL`     | 文件字节大小。                                                                       |
| `storage_key`  | `TEXT NOT NULL UNIQUE` | 受控相对存储键，只允许小写字母、数字、`/`、`_`、`-`，且禁止绝对路径、`..` 与反斜杠。 |
| `content_hash` | `TEXT NOT NULL`        | 附件二进制内容哈希，用于完整性校验、导入导出校验与元数据/物理文件一致性检查。        |
| `created_at`   | `INTEGER NOT NULL`     | 上传或登记时间。                                                                     |

`storage_key` 不保存任意实际文件路径。应用应使用 `<knowledge-base-root>/attachments/<storage_key>` 解析物理路径，避免机器迁移、路径穿越和环境信息泄露。

### `storage_cleanup_jobs`

物理文件删除的持久化补偿队列。它不关联附件外键：创建任务时附件元数据可能已经删除；这样即使进程在数据库提交后退出，也不会遗失清理意图。

| 字段 | SQLite 类型 / 约束 | 含义 |
| --- | --- | --- |
| `id` | `TEXT PRIMARY KEY` | 清理任务 UUID。 |
| `storage_key` | `TEXT NOT NULL UNIQUE` | 待清理的受控附件存储键；同一文件只保留一个任务。 |
| `reason` | `TEXT NOT NULL` | 创建任务的原因，如最后一个引用移除、上传回滚或孤儿扫描。 |
| `attempts` | `INTEGER NOT NULL` | 已尝试删除次数。 |
| `last_error` | `TEXT` | 最近一次删除失败信息，成功时清空。 |
| `created_at` | `INTEGER NOT NULL` | 任务创建时间。 |
| `completed_at` | `INTEGER` | 物理删除成功后的完成时间；`NULL` 表示仍待重试。 |

后台任务只处理 `attachments/` 前缀下的键。执行前会再次检查 `attachments.storage_key`：若该键又被有效附件使用，任务仅标记完成，绝不删除文件。

### `notes_fts`

SQLite FTS5 虚拟表，不是正文的权威数据源，而是从 `notes` 投影的可重建搜索索引。采用 **external-content** 模式：`notes_fts` 不持有正文字段的真实副本，而是通过 `content='notes'` 与 `content_rowid='rowid'` 与 `notes` 表的行联动。

| 字段              | FTS5 定义     | 含义                                                |
| ----------------- | ------------- | --------------------------------------------------- |
| `title`           | 可搜索        | 笔记标题，投影自 `notes.title`。                    |
| `plain_text`      | 可搜索        | 正文纯文本，投影自 `notes.plain_text`。             |
| `properties_json` | 可搜索        | 笔记属性 JSON 文本，投影自 `notes.properties_json`。 |

创建语句：

```sql
CREATE VIRTUAL TABLE notes_fts
USING fts5(title, plain_text, properties_json, content='notes', content_rowid='rowid');
```

搜索使用 `MATCH` 与 `bm25(notes_fts)` 排序，通过 `JOIN notes n ON n.rowid=notes_fts.rowid` 回查结果。每次有效保存会在与 `notes` 更新相同的 SQLite 事务内执行 external-content 的 `'delete'` 与重新 `INSERT`（按 `notes.rowid` 联动），确保索引与 `notes` 同步且每个笔记只有一条投影记录。受保护笔记启用时会从 `notes_fts` 删除其投影，因此搜索、最近修改和归档列表永远不返回受保护笔记；关闭保护时由服务端重建投影。

由于 external-content FTS 以源表 `rowid` 为键，**重复索引在结构上不可能**：每个 `notes.rowid` 在 `notes_fts` 中最多有一条记录。领域服务因此把 `findDuplicateSearchIndexEntries()` 实现为返回空数组的占位诊断；真正的完整性检查由 `doctor` 通过 `notes_fts_docsize` 表统计（见 [运行与维护](operations.md#6-完整性检查ygdria-doctor)）：

```sql
SELECT n.id noteId, COUNT(*) count
FROM notes_fts_docsize f JOIN notes n ON n.rowid=f.id
GROUP BY f.id HAVING COUNT(*) > 1;
```

启动迁移会重建 FTS 索引；后续若该检查返回记录，应视为索引写入路径存在缺陷。`notes_fts_delete_on_note_delete` 触发器会在普通未删除笔记被永久删除时同步从 FTS 删除其投影；已删除或受保护笔记的删除不会触发该触发器（其投影在更早的删除/启用保护流程中已被移除）。检查与重建命令、写锁要求和输出字段见 [运行与维护](operations.md#5-数据库与全文检索维护)。

### `sync_change_log`

增量同步的有序变更日志：每次实体变更（创建 / 更新 / 删除）写入一行，按自增 `id` 严格有序。`sync_cursors` 记录每个 peer 已确认的 `lastAdvance_id`（即最大变更 `id`），客户端据此拉取 `(cursor, +∞)` 区间的变更实现增量同步。该表由 Drizzle Schema 定义（非迁移 SQL 创建），是 §1 业务表枚举的一员。

| 字段           | SQLite 类型 / 约束                                              | 含义                                                                 |
| -------------- | -------------------------------------------------------------- | -------------------------------------------------------------------- |
| `id`           | `INTEGER PRIMARY KEY AUTOINCREMENT`                            | 自增变更 ID，即同步游标的推进位点；`0` 表示无历史同步。               |
| `entity_type`  | `TEXT NOT NULL`                                                | 实体类型：`note`、`placement`、`placement-order`、`relation`、`attachment`、`revision`、`setting`。            |
| `entity_id`    | `TEXT NOT NULL`                                                | 实体 ID。                                                            |
| `change_kind`  | `TEXT NOT NULL`（`created` / `updated` / `deleted`）          | 变更类型。                                                           |
| `created_at`   | `INTEGER NOT NULL`（毫秒时间戳）                              | 变更写入时间。                                                       |

索引：`sync_change_log_order_idx`（`id`）、`sync_change_log_entity_idx`（`entity_type, entity_id`）。写入与 `notes` 等实体更新在同一事务内完成，确保变更日志与业务数据一致。

### `sync_tombstones`

多端同步用的删除墓碑表。它不是业务表，也不进 FTS；作用是让同步对端区分"某条记录从未在本端创建"与"某条记录本端曾创建但已被删除"，避免旧快照复活已删除数据。

| 字段          | SQLite 类型 / 约束                  | 含义                                                                 |
| ------------- | ----------------------------------- | -------------------------------------------------------------------- |
| `entity_type` | `TEXT NOT NULL`                     | 实体类型：`note`、`placement`、`relation`、`attachment`、`setting`。 |
| `entity_id`   | `TEXT NOT NULL`                     | 实体 ID。                                                |
| `deleted_at`  | `INTEGER NOT NULL`                 | 删除时间戳（毫秒）。                                                 |

主键 `(entity_type, entity_id)`。墓碑由数据库触发器维护——每次 `DELETE` 在 `sync_tombstones` 写入（或更新）一条墓碑，每次 `INSERT` 删除对应墓碑。这保证任何写入路径（包括级联删除和未来外部调用者）都会产生墓碑。`POST /api/v1/sync/push` 合并变更时按墓碑时间戳过滤掉已删除记录；撤销 placement 删除或恢复回收站笔记会触发 `INSERT`，从而在下一次同步时清除对应墓碑。

### `sync_cursors`

增量同步的 peer 游标表，记录每个已连接 peer 当前同步到的位置。它不是业务表，不参与任何业务逻辑，仅用于同步 API 的游标维护。

| 字段             | SQLite 类型 / 约束 | 含义                                                |
| ---------------- | ------------------ | --------------------------------------------------- |
| `peer_id`        | `TEXT PRIMARY KEY`  | peer 标识，由客户端在首次同步时生成。                |
| `last_advance_id` | `INTEGER NOT NULL DEFAULT 0` | 该 peer 已确认的最大同步变更 ID。`0` 表示无历史同步。 |
| `advanced_at`    | `INTEGER NOT NULL`  | 游标最后推进时间（毫秒）。                           |
| `last_active_at` | `INTEGER`，可空     | 最后活跃时间（毫秒）。用于 pruneChangeLog 判断 peer 是否已过期；超期 peer 的游标会被丢弃，下次同步需从快照基线重建。 |

`last_advance_id` 为 `0` 时，客户端应从 0 开始拉取全量变更日志作为基线。`pruneChangeLog` 维护函数以所有 peer 的 `MIN(last_advance_id)` 为基准，删除更旧的变更日志记录。

### `placement_deletions`

短期、一次性的 placement 删除撤销记录。它不是长期版本历史，也不替代 `revisions`。

| 字段            | SQLite 类型 / 约束 | 含义                                                                         |
| --------------- | ------------------ | ---------------------------------------------------------------------------- |
| `id`            | `TEXT PRIMARY KEY` | 撤销记录 UUID，也是撤销 API 的标识。                                         |
| `snapshot_json` | `TEXT NOT NULL`    | 被删除 placement 子树或整篇笔记全部 placement 的完整位置快照，以及因此自动进入回收站的 note ID 列表。 |
| `created_at`    | `INTEGER NOT NULL` | 删除动作发生时间。                                                           |
| `undone_at`     | `INTEGER`，可空    | 撤销完成时间；`NULL` 表示尚可撤销。                                          |

`placement_deletions_active_idx(undone_at, created_at)` 支持查询可用撤销记录。每次删除 placement 子树或整篇笔记都会创建一条独立记录；整篇笔记删除会保存其所有 clone 位置及这些位置的子树。因此可以撤销多个不同的删除动作，并非只能撤销最后一次；同一记录只能撤销一次。后续清理任务可按保留期删除过期记录。

## 4. 保存与并发

正文保存必须在一个 SQLite 事务内完成：

```text
输入 Tiptap JSON / Markdown
        │ Markdown 时先解析、校验
        ▼
稳定序列化并计算 content_hash
        │
        ├─ hash 未变化：跳过正文保存与 revision
        ▼
写入旧正文到 revisions（仅正文变化；用 encodeDocumentContent 按 ≥2 KiB 阈值选择 identity/zstd-v1 编码）
更新 notes（content_data + content_codec + content_size）与 notes_fts
提交事务
```

稳定序列化会按对象键排序再计算 SHA-256，避免仅因 JSON 对象键顺序不同产生伪变化。正文、历史版本和全文索引都在同一个事务中更新，避免出现正文已更新而索引仍是旧内容的中间状态。受保护笔记走单独的 `ciphertext-v1` 写入路径：服务端只接收 `contentCiphertext`，用 `encodeCiphertextContent` 直接以 UTF-8 存为 BLOB，**永不压缩**（压缩密文无意义且会破坏认证标签）；不创建 revision，从 FTS 删除投影。

最终写入使用 `WHERE id = ? AND version = ? AND deleted_at IS NULL`。受影响行数为 `1` 才算成功；`0` 表示版本冲突、笔记不存在或已进入回收站，服务端返回 `409 Conflict`。这使自动保存、多窗口与移动端同步不会静默覆盖更新。当 409 确实发生时（多设备经直接保存并发修改同一篇笔记），Web 客户端会弹出保存冲突对话框，展示服务端版本与本地未保存版本的 GitHub 风格 diff，并提供「保留我的 / 采用远端 / 稍后处理」三种处理；详见 [架构设计 §4.1.7](architecture.md#417-保存冲突提示)。

### 4.1 客户端自动保存去抖与修订节流

连续输入不应每次击键都落库或建修订。`apps/web/src/hooks/useNotes.ts` 的 `autoSave` 采用「尾随去抖 + 时间窗」两段式策略：

- **尾随去抖 1000ms**：编辑器 `onUpdate` 触发 `autoSave` 后，若用户停顿 ≥1 秒才真正发出保存请求；连续击键只会重置计时器，不重复发请求。
- **时间窗上限 = 快照间隔**：同时记录本次输入窗口的起点 `autoSaveWindowStartRef`；当 `Date.now() - 窗口起点 >= revisionIntervalMs`（由设置 `revisionIntervalMinutes` / `revisionIntervalUnit` 经 `durationMs` 换算）时，立即 flush。因此即使不间断打字（永不出现 ≥1s 停顿），也**至多每间隔保存一次**，不会无限卡在内存里丢失编辑。
- 每次 flush 携带 `expectedVersion`，走与普通保存相同的乐观并发控制。

服务端在落库时再按间隔节流修订：`domain.NoteService.shouldCreateRevision(noteId, t, intervalMs)` 仅当 `t - 最新修订.createdAt >= intervalMs` 时才写入一条新 revision。两者叠加的效果是：**连续输入既不会每次击键建修订（服务端节流），也不会因没有停顿而永不保存（客户端时间窗）**。仅当正文 `content_hash` 真的变化且距上次修订已达间隔，才会新增修订；`content_hash` 未变的自动保存不创建 revision、不更新 FTS、不递增版本（与 `notes.content_hash` 的语义一致）。

## 5. 删除、回收站与永久删除

clone 模型中，“删除位置”和“删除笔记”是不同动作：

| 动作         | 数据库操作                                                                          | 对 clone 的影响                                                                               |
| ------------ | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 从此位置移除 | 保存撤销快照后执行 `DELETE placements WHERE id = ?`                                 | 级联删除该 placement 子树，不直接设置 `notes.deleted_at`。仍有其他 placement 的笔记保持正常。 |
| 移入回收站   | 设置目标 `notes.deleted_at`，删除它的普通 placement，并在固定回收站下创建 placement | 针对整个笔记实体；正常树和 FTS 不再显示该笔记。                                               |
| 永久删除笔记 | `DELETE notes WHERE id = ?`                                                         | SQLite 级联删除 placement、relation、revision；仍被其他笔记正文引用的附件保留。   |

删除 placement 子树或整篇笔记前，领域服务都会记录完整 placement 快照；删除后若某篇笔记已没有任何 placement，会将它自动移入回收站，避免产生用户不可访问的孤儿笔记。整篇笔记删除会先删除其所有 clone 位置及其子树。仍有其他 clone 位置的笔记不会被软删除。回收站在树中保留已删除笔记的只读入口，汇总历史也会保留并标记这些记录；正常树和 FTS 不显示它们。调用撤销接口或“恢复笔记”时，服务端恢复原 placement 子树、移除本次自动创建的回收站 placement，并恢复相应 note 的 `deleted_at`。若原父 placement 已不存在，则该子树根节点降级恢复到固定根节点。

永久删除笔记还会通过 `notes_fts_delete_on_note_delete` 触发器清理 FTS 投影。若附件不再被任何笔记正文引用，服务端会删除该附件元数据并创建 `storage_cleanup_jobs` 任务；仍被其他笔记引用的附件和物理文件会保留。后台任务负责可靠地删除孤立物理文件。系统根和回收站笔记、placement 都不可删除、移动、重命名或作为普通 clone 使用；普通笔记也不能通过移动 placement 的方式直接放入回收站，必须使用“移入回收站”命令。

永久删除笔记（单条 `purge` 或批量 `purgeTrash`）现在也会把被删笔记写入 `sync_change_log`（`changeKind = "deleted"`），使回收站清空能跨设备传播，而不是只在执行那台设备上消失。接收端在 `applySyncChanges` 处理 `note` + `deleted` 时按本地状态分流：若本地该笔记**已在回收站**（`deleted_at` 非空），则直接硬删本地——`placements` / `relations` / `revisions` 都有 `ON DELETE CASCADE`，会一并级联清除——让两台设备数据库尽快一致；若本地该笔记**仍在使用中**（罕见冲突：本端恢复过、对端已清空），则保持软删（移回收站、可恢复），不静默销毁已恢复内容。因此「清空回收站」会在各端一致地清空。

「移入回收站」（`remove`）同样会为被删的**原始树 placement** 写入 `sync_change_log`（`entity_type = "placement"`，`changeKind = "deleted"`）——此前只记录了 `note` 的 `deleted`，导致对端收到后只软删笔记并在本地另建回收站 placement，却保留了该笔记原来的树位置行，造成数据库不一致。补录后，接收端 `applySyncChanges` 的 `placement` + `deleted` 分支会把那些原位置一并删除，使两端一致。注意：移入回收站时**新创建的回收站 placement 不写同步日志**——回收站 placement 是各设备各自的本地视图产物（每台设备独立 `INSERT OR IGNORE` 一个自己的回收站 placement），无需跨设备对齐；而原树位置属于内容结构，必须跨设备删除。撤销（`undoPlacementDeletion`）与「恢复笔记」仍走本地的 `placement_deletions` 快照，并通过 `note` + `updated`（`deleted_at` 置空）让对端在恢复时清除其回收站 placement，因此补录 `placement` 删除不会干扰撤销/恢复的对端重建（同实体的「删除 + 创建」会在 `getCoalescedChangesSince` 中收敛为创建）。

「清理未使用的附件」（`clearUnusedAttachments`）同样会为每一个被删附件写入 `sync_change_log`（`entity_type = "attachment"`，`changeKind = "deleted"`），使清理结果跨设备传播。接收端 `applySyncChanges` 没有单独的 `attachment` 分支：显式的 `attachment` 删除变更会被并入 `attachmentCleanupCandidates`，在批次末尾由既有的引用感知清理函数（`cleanupUnreferencedSyncAttachments`）统一处理——**仅当本地没有任何笔记正文仍引用该附件时才删除元数据行**，从而确定性地收敛，又不会误删对端仍在使用的附件。这与删笔记后 `queueUnreferencedAttachmentCleanup` 的行为一致。

## 6. 归档与批量树操作

归档笔记保留原 placement 和排序，并在树中弱化显示；直接链接、已有标签和引用仍可打开它。默认搜索与最近修改排除未删除的归档笔记，归档页按 `archived_at DESC` 列出可恢复笔记。回收站 placement 保留在数据库，但默认隐藏在笔记树中，恢复入口位于最近修改。

树支持同层多选：`Ctrl/Cmd` 点击增减选择，`Shift` 点击选择连续范围。批量菜单提供剪切、复制/克隆、同层前后粘贴、移动、归档、删除和 JSON/Markdown 导入导出；导入导出格式可在设置中选择。

## 7. SQLite 配置与迁移

启动时执行：

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
```

WAL 改善读写并发；外键阻止 placement、relation、revision 关联指向不存在的实体。所有从属外键都显式使用 `ON DELETE CASCADE`，不依赖 SQLite 默认的 `NO ACTION`。`applyMigrations()` 是幂等迁移：新库自动建表，显式 `migrate` 命令也可安全重复执行。

旧数据迁移会补齐 `notes` 中的正文、哈希、纯文本和属性 JSON，并从旧 `contents`、`properties` 表回填数据；同时创建系统根与回收站，并将旧的顶层 placement 收拢到根下。历史数据库可能保留不再使用的 `markdown_cache` 列，但新代码不会读取或写入它，Markdown 会从解码后的 `content_data` 按需生成。旧版 `attachments.note_id` 会迁移至正文 JSON 引用，旧 `attachments.hash` 会回填至 `content_hash`；随后附件表会重建，移除旧的单 note 外键，确保共享附件不会随任一笔记被级联删除。`storage_cleanup_jobs` 会以 `CREATE TABLE IF NOT EXISTS` 新增，不影响既有附件。`sync_tombstones` 与其触发器同样以 `CREATE TABLE IF NOT EXISTS` / `CREATE TRIGGER IF NOT EXISTS` 安装。因为 SQLite 不能用 `ALTER TABLE` 为已有外键追加 `ON DELETE`，迁移会保留数据后重建 placement、relation 和 revision 表，以写入明确的级联约束。后续 Schema 调整需要同步更新 Drizzle Schema、迁移 SQL、领域服务、FTS 投影及 Markdown 转换逻辑。

## 8. 完整性检查与修复

运行方式、环境变量和写锁要求见 [运行与维护](operations.md#6-完整性检查ygdria-doctor)。`corepack pnpm ygdria doctor` 输出 JSON 报告，并在发现问题时返回退出码 `1`。它检查 SQLite 的 `PRAGMA integrity_check` 与 `PRAGMA foreign_key_check`，以及以下应用不变量：

- `notes.content_hash` 是否等于稳定序列化正文的 SHA-256，`plain_text` 是否能从正文重新生成（受保护笔记跳过，因其密文无法重新派生纯文本）；
- FTS 的缺失、已删除笔记残留和悬空 `rowid`；重复索引通过 `notes_fts_docsize` 统计（external-content FTS 结构上不可能重复）；
- 附件文件是否位于受控存储根中（`attachment-storage-key-unsafe`，防止路径穿越）、是否存在、大小和 SHA-256 是否等于附件元数据；
- 普通笔记是否完全没有 placement、placement 父链是否存在环、笔记类型是否在允许集合内；
- note 与 revision 的 `content_data` 解码后是否是有效 JSON，且能通过当前正文 schema 解析；revision 同时校验内容哈希。

`corepack pnpm ygdria doctor --fix` 仅修复可从权威数据安全重建的投影，返回结构：

```json
{
  "rebuiltSearchIndex": true,
  "rebuiltPlainTextCount": 0,
  "removedTemporaryFiles": 0,
  "renumberedPlacementCount": 0,
  "markdownCache": "not-applicable"
}
```

具体动作：重建 FTS（DROP + CREATE，跳过受保护笔记，避免误把密文写进索引）、重建有效正文的 `plain_text`、按每个父 placement 重新编号 `position`（修复同层重号或空号），以及清理受控临时目录 `attachments-tmp` 中的上传残留。当前模型按需从 `content_data` 生成 Markdown，未保存 `markdown_cache`，所以该项会报告为 `not-applicable`。正文 JSON、revision、附件元数据、关系和有环 placement 均不会自动篡改，须人工处理或从备份恢复。