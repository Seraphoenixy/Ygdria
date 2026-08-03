# 认证、受保护笔记与同步

本页集中说明身份认证、设备凭据、受保护笔记的端到端加密模型，以及多实例/多端访问时的同步机制。相关端点见 [API 与内容格式](api.md)；环境变量与初始化操作见 [运行与维护](operations.md)。

## 1. 两种运行形态

Ygdria 的认证策略取决于运行形态，二者使用同一份 `buildApp` 代码，仅由启动参数区分：

| 形态 | 入口 | 监听 | 设备认证 | 设备凭据存储 |
| --- | --- | --- | --- | --- |
| A：桌面内嵌服务 | `apps/desktop/src/main.ts` 启动 Fastify | loopback 端口（默认 4318） | 关闭（`enableDeviceAuth` 未传） | 远端服务器凭据由主进程持有，经 Electron `safeStorage` 加密落盘；渲染进程只通过 IPC 间接访问 |
| 形态 B：独立服务器 | `apps/server/src/index.ts` | `127.0.0.1:PORT`；远端部署需反向代理 HTTPS | **始终开启**（`index.ts` 硬编码 `enableDeviceAuth: true`） | 内存，不持久化 |

形态 A 是默认形态：桌面主进程在同一进程内启动 Fastify，Renderer 通过 `contextIsolation` + `sandbox` 访问本地 API，数据库文件位于用户应用数据目录。形态 A 不需要设备令牌，因为只有本机 Renderer 能访问 loopback 端口；受保护笔记的主密码此时只保护"文件密钥"，不绑定服务端登录。

形态 B 用于多端共享同一知识库：手机、远程浏览器或第二台桌面连接到一个常驻服务器进程。此时设备认证始终启用，并应经反向代理对外仅暴露 HTTPS。

### 1.1 桌面端远端代理（形态 A → 形态 B 同步）

桌面端把本地知识库与形态 B 服务器同步时，**渲染进程绝不直接请求远端**。所有远端调用由 Electron 主进程代理：

```text
渲染进程 (React UI)
  │ IPC：ygdria:remote:{status,configure,disconnect,test,request}
  │ （请求中不含 deviceToken）
  ▼
Electron 主进程
  ├─ 持有 serverUrl + deviceToken（safeStorage 加密落盘）
  ├─ 路径白名单（13 条精确前缀，拒绝任意 URL）
  ├─ 强制 HTTPS、redirect: 'error'（禁止重定向，防止 origin 跳变）
  ├─ 注入 Authorization: Bearer <deviceToken>
  ├─ SSRF 防护：解析后 origin 必须与配置的 serverUrl 一致
  └─ 拦截 /devices/initialize 与 /auth/login/verify 响应中的 deviceToken
     → 直接写入 safeStorage，返回脱敏响应给渲染进程
  │ Node fetch（不受浏览器 CORS 限制）
  ▼
HTTPS 远端服务（形态 B）
```

该架构的安全意义：

- **CSP 无需放宽**：渲染进程只与 `127.0.0.1:4318` 同源通信，`connect-src 'self'` 继续生效，缩小 XSS 后的外传通道。
- **远端服务器无需为桌面端开 CORS 例外**：主进程的 Node fetch 不受浏览器 CORS 约束；服务端 CORS 白名单只保留 `origin` 自身。
- **deviceToken 永不进入渲染进程**：主进程在 IPC 内部拦截 `initialize` / `verify` 响应，把 token 写入 safeStorage，只把脱敏后的对象回传给渲染进程。渲染进程的 `RemoteProxyClient.setDeviceToken()` 是空操作。
- **SSRF 防护**：IPC 只接受路径白名单（认证、同步、附件按哈希上传/下载），禁止任意 URL；解析后的 origin 必须与用户确认的 serverUrl 一致；`redirect: 'error'` 阻断 origin 跳变。

浏览器模式（非 Electron）仍使用直接的 `YgdriaClient`：此时浏览器页面与服务器同源，CSP `connect-src 'self'` 允许请求，deviceToken 保存在 `sessionStorage`。

## 2. 认证机制

服务端有两个独立、可叠加的认证层，按请求顺序执行：

### 2.1 本地令牌（`X-Ygdria-Local-Token`）

- 由 `buildApp({ localToken })` 传入；为空时不校验。
- 桌面内嵌服务当前不设置该令牌（loopback 已经是信任边界）。
- 所有非 `OPTIONS` 请求都必须携带该头，否则返回 `401`。
- 它是共享密钥，不区分设备，适合单用户本机或开发场景。

### 2.2 设备凭据（`Authorization: Bearer <deviceToken>`）

仅当 `enableDeviceAuth` 为真时启用（形态 B 始终为真）。特点：

- **内存存储，不持久化**：服务器重启后所有设备令牌失效，需要重新登录或配对。这是刻意设计——保证设备凭据绝不进入数据库同步路径，避免一份库被复制后旧令牌仍然有效。
- **只保留 `sha256(token)`**：明文 `deviceToken` 和 `pairingToken` 仅在签发时返回一次，之后不再存储。
- **5 天滑动空闲超时**（`DEVICE_TOKEN_IDLE_TIMEOUT_MS`，固定不可配置）：每次认证请求刷新 `lastActiveAt`；超过 5 天未使用的令牌在下次校验时被删除并返回 `401`。
- 静态资源与 SPA 壳始终公开；`/api/*` 与 `/etapi/*` 受保护。`/api/*` 只接受设备令牌；`/etapi/*` 还接受由设备令牌签发、带 scope 的短期 ETAPI 令牌。
- 公开路径白名单：`/api/v1/health`、`/api/v1/auth/config`、`/api/v1/devices/initialize`、`/api/v1/auth/login/challenge`、`/api/v1/auth/login/verify`、`/api/v1/devices/pair`。
- 校验通过后把 `device` 挂到请求对象上，供 `/api/v1/devices/me` 等端点读取。

设备凭据不与数据库绑定，因此它不是"用户账户"：它只授权某台设备在当前服务器进程生命周期内（且 5 天内有活动）访问该库。

### 2.3 ETAPI 短期凭据

已认证设备可通过 `POST /api/v1/etapi/sessions` 签发 1～60 分钟有效的短期令牌，并限定为 `notes:read`、`notes:write` 或两者。短期令牌只可调用 `/etapi/*`，明文同样只返回一次，服务端只在内存中保留 SHA-256 摘要；到期、主动撤销、签发设备撤销、主密码变更或服务器重启都会使其失效。接口契约见 [ETAPI：AI 与外部自动化](etapi.md)。

## 3. 统一主密码模型

形态 B 采用**单一主密码**驱动两条独立的派生路径，二者用各自的随机盐和域分离串，杜绝密钥复用：

```
主密码（永不离开客户端）
   ├─ PBKDF2(password, fileSalt)              → AES-256-GCM 文件密钥（加密受保护笔记）
   └─ PBKDF2(password, accessSalt, ACCESS_SECRET_CONTEXT) → accessSecret
                                                              └─ 作为 SRP-6a 的密码进行注册/登录
```

- 主密码、文件密钥、accessSecret **永不离开客户端**。
- 服务端只存两个盐、SRP 验证器（verifier）和 KDF/协议版本元数据，永不存主密码、文件密钥、accessSecret 或静态哈希。
- 认证是 PAKE（SRP-6a）挑战-响应，无可重放材料在网络中传输。
- 常量：`SRP_USERNAME="ygdria"`、`ACCESS_SECRET_CONTEXT="ygdria/v1/access-secret"`、`MASTER_PASSWORD_PBKDF2_ITERATIONS=600000`、`DERIVED_KEY_BITS=256`、`SALT_BYTES=16`、主密码长度 8–64（UTF-16 码元）。
- 协议/KDF 版本（`AUTH_PROTOCOL_VERSION="srp6a-v1"`、`KDF_VERSION="pbkdf2-sha256-v1"`）持久化到 settings，支持未来迁移。

### 3.1 首次初始化（第一台设备）

`POST /api/v1/devices/initialize`（公开，但仅在尚未初始化时可用）：

1. 客户端从主密码派生 accessSecret 与文件密钥，生成 `accessSalt`、`srpSalt`、SRP `verifier`，以及文件密钥的 `fileSalt`、`fileVerifier`。
2. 一次性提交 `{ accessSalt, srpSalt, verifier, fileSalt, fileVerifier, label }`。
3. 服务端在**单个事务**内写入 SRP 认证记录与受保护会话文件记录——二者要么一起落库，要么一起回滚，用户没有机会设置发散的文件密码。
4. 成功后签发第一台设备的 `{ deviceId, deviceToken }`。
5. 同时清除任何遗留的"独立服务访问密码"旧记录（`server_access_password_salt/hash`），避免陈旧哈希残留。

### 3.2 后续设备登录（SRP-6a）

已初始化后，新设备用主密码经 SRP-6a 登录：

```
客户端                                   服务端
  │  POST /auth/login/challenge             │
  │  { clientPublicEphemeral }              │
  │ ─────────────────────────────────────►  │  生成 serverEphemeral
  │                                          │  存 challengeId → serverSecret（5 分钟 TTL，一次性）
  │  ◄───────────────────────────────────── │  { challengeId, srpSalt, serverPublicEphemeral }
  │  本地用 accessSecret 派生会话与证明      │
  │  POST /auth/login/verify                │
  │  { challengeId, clientPublicEphemeral,  │
  │    clientSessionProof, label }          │
  │ ─────────────────────────────────────►  │  deriveSession 校验客户端证明
  │                                          │  消费 challengeId（无论成败）
  │                                          │  签发 { deviceId, deviceToken }
  │  ◄───────────────────────────────────── │  { deviceId, deviceToken, serverSessionProof }
  │  客户端必须验证 serverSessionProof（相互认证）
```

要点：

- `challengeId` 是一次性的：消费后即从内存删除，重放找不到记录。
- 服务端对"未初始化""verifier 损坏""密码错误"统一返回 `401 Authentication failed`，不泄露认证状态；只有 `/auth/config` 显式暴露 `initialized` 供 UI 决定是"设置主密码"还是"登录"。
- **登录失败节流**：同一 IP 5 次失败后冷却 30 秒（`accessLoginFailures` 内存表），抑制在线穷举与 SRP 计算负载。

### 3.3 配对令牌流程（无需主密码）

已登录设备可为另一台设备签发一次性配对令牌（例如桌面展示二维码、手机扫描）：

```
已配对设备：POST /devices/pairing-token  (Bearer <deviceToken>)
           => { pairingToken, expiresAt }   # 默认 5 分钟 TTL

新设备：    POST /devices/pair  { pairingToken, label }
           => { deviceId, deviceToken }     # deviceToken 仅此一次可见
```

配对令牌用过即失效，过期也会被清除。`/devices/pair` 同时也是公开白名单端点，因此无主密码的设备也能凭配对令牌加入。

### 3.4 撤销与主密码变更

- `DELETE /api/v1/devices/:id` 撤销单个设备；`POST /api/v1/devices/revoke-all` 撤销除当前设备外的全部设备。撤销即时生效。
- **主密码变更**（`POST /api/v1/protected-session/change-password`）：客户端用旧密码解密全部受保护笔记，用新密码重新加密，连同新的文件盐/校验值和新的 SRP 记录在**单事务**内提交。任一笔记版本冲突则整体回滚，文件密钥与服务访问密码保持一致，绝不出现"文件密码改了、访问密码没改"。成功后 `devices.revokeAll()` 作废所有现有令牌，每台客户端必须用新主密码重新登录。
- **改主密码的步进认证（step-up）**：在设备认证模式（形态 B）下，`change-password` 除新的 SRP 记录（`auth` 字段）外，**还必须携带 `reauthToken`**——即由最近一次 SRP `login/verify` 签发的 5 分钟有效令牌（与 `clear` 端点同款校验）。缺失/无效/过期的 `reauthToken` 将返回 401。本地桌面模式（形态 A，`enableDeviceAuth=false`）不受此限，与 `clear` 完全一致。前端在提交改密码前会先用*当前*主密码走一次 SRP `login/verify` 获取 `reauthToken`，从而确保"改主密码"这一账户接管级操作必须由持有主密码者本人发起。

## 4. 受保护笔记：端到端加密

受保护笔记让单条笔记的正文对服务器不可见。加密完全在客户端完成，服务器只保存密文和校验信息。

### 4.1 密码与密钥

- 主密码永不离开客户端，也不参与任何 API 请求（SRP 用的是 accessSecret，不是主密码本身）。
- 客户端用 PBKDF2-SHA256（600 000 次迭代，16 字节随机盐）派生 AES-256-GCM 文件密钥；派生密钥标记为 `non-extractable`，无法导出。
- 派生密钥只存在于客户端内存，**从不持久化**；锁定时立即销毁。
- 校验值（verifier）：用派生密钥加密固定明文，得到一段密文。服务端存这段密文，用于解锁时验证密码是否正确——而无需把密码或密钥送到服务端。

### 4.2 服务端存储

启用保护后，`notes` 行被改写为：

| 字段 | 值 |
| --- | --- |
| `title` | `""`（空） |
| `content_data` | 客户端产生的密文字符串 `v1.{base64url(iv)}.{base64url(tag)}.{base64url(ciphertext)}` 的 UTF-8 字节 |
| `content_codec` | `ciphertext-v1`（密文永不压缩） |
| `content_hash` | 密文的 SHA-256 |
| `plain_text` | `""`（空，确保不出现在搜索投影） |
| `properties_json` | `"{}"` |
| `is_protected` | `1` |

启用前服务端设置 `PRAGMA secure_delete=ON`，删除该笔记在 `notes_fts` 中的投影与全部 revision 历史旧密文版本，事务提交后执行 `VACUUM` + WAL checkpoint 以回收明文页。读取时服务端原样返回 `contentCiphertext`，不解密。受保护笔记不进 FTS、不进 history、不进归档列表；树结构仍保留其位置（标题显示为空，由前端在解锁后本地解密显示）。

### 4.3 受保护会话

受保护会话是客户端的内存状态：

- **配置**：首次初始化（`/devices/initialize`）或 `setup` 时写入 `protected_session_salt`、`protected_session_verifier`、`protected_session_timeout_ms`。
- **默认超时 10 分钟**（`DEFAULT_PROTECTED_SESSION_TIMEOUT_MS = 10*60*1000`），最小 1 分钟，`0` 不被允许（PATCH/校验强制 `>= 60000`）。
- **解锁**：从服务端读取 `salt` 与 `verifier`，本地派生密钥并尝试解密校验值；成功则密钥进入内存。
- **自动锁定**：闲置超过 `timeoutMs` 自动销毁密钥。
- **清除**（`/protected-session/clear`）：删除三个会话配置键，但**不会**自动解密已加密的笔记——已加密笔记仍保留密文，需要用原密码解锁后才能关闭保护。

在形态 B 下，`setup` 与 `change-password` 必须同时提交新的 SRP 记录（`auth` 字段），保证文件密钥与服务访问凭据统一迁移；`setup` 替换 SRP 记录后会 `devices.revokeAll()`。

### 4.4 信任边界

- 服务器、数据库管理员和数据库副本持有者**看不到**受保护笔记的明文、标题或纯文本。
- 保护是"单笔记级"而非"整库级"：未启用保护的笔记仍以明文存于数据库。
- 丢失主密码即丢失明文；服务端没有任何可恢复密文的途径。

## 5. 同步机制

Ygdria 提供**基于游标的增量同步**，不是 CRDT，也不做细粒度多人实时协作。同步以"按游标拉取增量 → 推送本地变更 → 推进游标"为单位，适合定期备份、设备间搬运或多端合并：

| 端点 | 用途 |
| --- | --- |
| `GET /api/v1/sync/changes?cursor=&limit=` | 拉取自 `cursor` 之后的增量变更记录，返回新的游标与是否还有更多。 |
| `POST /api/v1/sync/push` | 把客户端的变更列表推送到服务端，按 last-write-wins 时间戳合并；返回成功应用的条数。 |
| `POST /api/v1/sync/advance` | 推进指定 peer 的游标到给定值。 |
| `GET /api/v1/sync/cursor?peerId=` | 读取指定 peer 的当前游标（不存在时返回 `lastAdvanceId: 0`）。 |

### 5.1 变更日志与游标

- 服务端在 `sync_change_log` 表中按自增 `id` 有序记录每次实体变更（`entityType` / `entityId` / `changeKind` / `createdAt`）。每条 mutation（创建/更新/删除）写一行；删除额外写 `sync_tombstones` 墓碑。
- 每个 peer 在 `sync_cursors` 表中维护独立的游标行：`peerId → lastAdvanceId`。客户端分页拉取 `?cursor=N&limit=M`，服务端返回 `{ cursor, hasMore, changes, maxChangeId }`；客户端在成功应用后调用 `/sync/advance` 把游标推进到返回的 `cursor`。
- 游标为 `0` 时表示"无历史同步"，客户端应从 0 开始拉取全量变更日志作为基线。

### 5.2 合并语义（LWW + 墓碑）

- `push` 对每类实体按主键合并：保留 `updatedAt`（或 `createdAt`）更大者；时间戳相同时用确定性 JSON 序列化顺序打破平局。
- 删除由 `sync_tombstones` 表记录：数据库触发器在 `placements`/`notes`/`relations`/`attachments` 删除时写墓碑，插入时清除对应墓碑（撤销/恢复借此表达）。
- `push` 在应用变更前先用墓碑过滤掉已删除的活实体；变更应用后也会更新对应的墓碑或清除被复活实体的墓碑。
- **`relations` 已接入同步**（2026-08-02 实现）：创建/删除关系会在 `sync_change_log` 写 `entity_type='relation'` 变更；`applySyncChanges` 对 `relation` 分支使用 `INSERT OR IGNORE` 幂等写入，并以 `NOT EXISTS sync_tombstones(entity_type='relation' AND deleted_at >= created_at)` 拒绝已被对端删除的关系“复活”（与 `setting` 分支同构）。快照与基线重建均包含 relations。关系无 `updated_at`，语义不可变。
- **敏感设置不参与同步**：`auth_*`、`protected_session_*`、`server_access_password_*` 前缀的 settings 键在 `writeSetting` / `deleteSetting` 时不写入变更日志；`/sync/changes` 不返回其值或墓碑；`/sync/push` 拒绝修改这些键。这避免任何已认证设备通过同步通道覆盖认证材料（否则可导致账户接管）。
- 附件文件二进制内容**不进变更日志**：变更日志只携带 `attachment` 的元数据（`contentHash` / `filename`）。客户端在同步时根据 `contentHash` 调用 `GET /api/v1/attachments/by-hash/:hash` 下载、`POST /api/v1/attachments/by-hash/:hash` 上传，按哈希去重。
- **永久删除（清空回收站）也会同步**：`purge` / `purgeTrash` 把被删笔记写入 `sync_change_log`（`deleted`）。接收端收到 `note` + `deleted` 时分流：本地该笔记已在回收站则硬删本地（依赖 `ON DELETE CASCADE` 级联）让两端库一致；本地仍在使用则软删（移回收站、可恢复），避免静默销毁已恢复内容。详见 [数据模型 §5](data-model.md#5-删除回收站与永久删除)。
- **移入回收站也会同步原树位置**：`remove`（移入回收站）除了记录 `note` 的 `deleted`，现在还会为被删的**原始树 placement** 记录 `placement` / `deleted`。此前只记了 `note`，对端收到后只软删笔记并自建回收站 placement，却保留了该笔记原来的树位置行，两端数据库不一致。补录后接收端会把原位置一并删除。新创建的回收站 placement 仍**不**写同步日志（各设备各自的本地视图产物），撤销/恢复走本地 `placement_deletions` 快照并通过 `note` + `updated` 让对端清除其回收站 placement，故补录不会干扰撤销/恢复。详见 [数据模型 §5](data-model.md#5-删除回收站与永久删除)。
- **清理未使用的附件也会同步**：`clearUnusedAttachments`（UI 的「清理未使用的附件」按钮及维护任务）为每个被删附件写入 `sync_change_log`（`attachment` / `deleted`）。接收端 `applySyncChanges` 没有独立的 `attachment` 分支，显式 `attachment` 删除变更会被并入 `attachmentCleanupCandidates`，在批次末尾由引用感知清理函数统一处理——仅当本地无任何笔记正文仍引用该附件时才删除元数据行。这样附件的删除也能确定性收敛，而不会因变更被静默丢弃而让对端长期残留过期附件行。

### 5.3 同步边界与多端访问

- **单权威库优先**：多端同时编辑同一常驻服务器（形态 B）时，并发由乐观版本号（`expectedVersion` / `If-Match`）控制，冲突返回 `409`。Web 客户端在直接保存命中 409 时会弹出**保存冲突对话框**：拉取服务端最新内容，以 GitHub 风格 diff 展示「远端 vs 本地未保存」差异，并提供「保留我的 / 采用远端 / 稍后处理」三种处理（保留我的 = 查看 diff 后显式以新 `expectedVersion` 覆盖；采用远端 = 失效缓存采用服务器内容；稍后处理 = 保留本地编辑不动作）。这是首选的多端模式。注意该对话框只覆盖直接保存路径；经 `sync/push` 的 last-write-wins 合并不会触发 409，也不会弹窗（见 [架构设计 §4.1.7](architecture.md#417-保存冲突提示)）。
- **增量同步是离线/迁移手段**：`sync/push` 的 LWW 不处理字段级冲突——同时修改同一笔记时，较旧的一方会被整体丢弃。它适合"主库定期推到备份库"或"多端搬运"，不适合双向高频同步。
- **设备凭据不跨库**：设备令牌只存在于服务器进程内存。增量同步不携带设备令牌；把数据库迁移到新服务器后需要重新登录或配对。
- **受保护笔记天然可迁移**：密文随变更日志原样传输，新库用原主密码即可解锁。
- **不要双写**：不要把同一份 SQLite 文件同时挂到多个服务器进程，WAL 不跨进程协调，会导致写冲突或损坏。需要迁移时停服后整体搬运数据库文件与 `attachments/` 目录。
- **维护任务冷却**：`POST /api/v1/maintenance/database` 有 15 分钟冷却（`MAINTENANCE_COOLDOWN_MS`），冷却期内返回 `429`；同时只允许一个任务排队或运行，第二个请求返回 `409`。这防止维护接口被滥用为 DoS。

### 5.4 同步环预防（`X-Ygdria-Sync-Origin`）

当桌面端（形态 A）通过远端代理将本地知识库与形态 B 服务器同步时，存在同步环的风险：桌面端轮询远端拉取变更 → 写入本地 SQLite → 本地 `sync_change_log` 产生新记录 → 下次拉取时这些记录又被推送到远端 → 远端写入 `sync_change_log` → 再次被拉取回来。

为防止此循环，形态 A 在以下场景中标记请求头 `X-Ygdria-Sync-Origin: remote`：

1. **`POST /api/v1/sync/push`**：远端拉取的变更在推入本地时，服务端通过 `isPulledRemoteWrite(req)` 检查该头部，若为 `remote` 则跳过 `sync_change_log` 写入，避免本地为远端变更创建新的同步记录。
2. **`POST /api/v1/attachments/by-hash/:hash`**：同步附件上传时，`recordSyncChange` 参数设为 `false`，避免附件元数据的同步变更再次被记录。

`isPulledRemoteWrite` 的实现要求 `localToken` 已配置（形态 A 本地 API 的安全标志），且请求头 `x-ygdria-sync-origin` 精确等于 `"remote"`。形态 B（独立服务器）忽略此头部，因为其所有客户端都是直接写入的，必须始终产生同步记录。
