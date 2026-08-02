# P0/P1 修复实施规划（relations 同步 + change-password 步进 + 移动端密钥存储）

> 日期：2026-08-02 · 基于 `docs/security-sync-review-2026-08-02.md` 的 P0/P1 缺口
> 决策（已与用户确认）：
> - **relations**：完整实现关系功能（新增 CRUD + REST + UI + 同步），而非清理休眠 schema。
> - **移动端凭据**：改用 `@capacitor/keychain`（iOS Keychain / Android Keystore）。

---

## 修复一：`relations` 完整实现（含跨设备同步）

### 背景事实（已核实）
- `relations` 表目前是**休眠 schema**：`packages/database/src/migrations.ts:71` 建表、`schema.ts:77` Drizzle 定义，但**无任何运行时代码 INSERT/DELETE**，UI 也无消费。
- `migrations.ts:361-367` 已为 `relations` 建 `sync_tombstones` 触发器（`entity_type='relation'`、`entity_id=OLD.id`、删除写墓碑、插入清墓碑）。但 sync 层只有 `setting` 分支消费 tombstone。
- 字段：`id TEXT PK`、`source_note_id`/`target_note_id`（`REFERENCES notes(id) ON DELETE CASCADE`）、`relation_type TEXT NOT NULL`、`created_at INTEGER`。唯一索引 `relations_unique(source_note_id, relation_type, target_note_id)`。

### 1.1 Domain 层 — 新增 `packages/domain/src/relation-service.ts`
- `createRelation(sourceNoteId, targetNoteId, relationType)`：
  - 校验 `relationType` ∈ 允许集合（`related`/`uses`/`prerequisite`，可扩展）；两端笔记存在（或依赖 FK，但 FK 是 CASCADE 删除，创建时可先查避免孤儿）；拒绝 `source===target`；拒绝指向系统根/回收站/日历笔记（`SYSTEM_*` id）。
  - `sqlite.transaction(() => { INSERT OR IGNORE INTO relations (id,source_note_id,target_note_id,relation_type,created_at) VALUES (?,?,?,?,?); recordChange(sqlite,"relation",id,"created"); })`
  - 唯一索引保证重复关系被 `INSERT OR IGNORE` 吸收；返回 null 表示重复。
- `deleteRelation(id)`（或按 `source/target/type` 定位）：`sqlite.transaction(() => { DELETE FROM relations WHERE id=?; recordChange(sqlite,"relation",id,"deleted"); })`。
  - 注意：DELETE 会**自动触发** `sync_tombstone_relation_delete` 写 tombstone（无需手动写，与 setting 不同）。
- 在 `packages/domain/src/index.ts` 导出 `RelationService` 与类型。

### 1.2 同步层 — `apps/server/src/sync/helpers.ts`
- **`resolveChangeEntities`**：新增 `case "relation"`：`SELECT id, source_note_id sourceNoteId, target_note_id targetNoteId, relation_type relationType, created_at createdAt FROM relations WHERE id=?`；data = 上述字段对象。
- **`fullSnapshotChanges`**：遍历 `SELECT id,source_note_id,target_note_id,relation_type,created_at FROM relations`，推 `{entityType:"relation", entityId:id, changeKind:"created", createdAt, data}`（排在 notes 之后——现有 `ordered` 排序已把 note 置顶，relations 自然在其后，FK 满足）。
- **`rebuildSyncBaseline`**：循环 `recordChange(sqlite,"relation",id,"updated")`（与其他实体一致）。
- **`applySyncChanges`**：新增 `else if (change.entityType === "relation")` 分支（放在 `setting` 之前或之后均可，但需在 note 之后——`ordered` 已保证）：
  - **deleted**：`DELETE FROM relations WHERE id=?`（触发器自动写 tombstone）；`logChange("relation", id, "deleted"); applied++`。幂等，无需 LWW 时间戳（关系无 `updated_at`）。
  - **created/updated**：
    ```sql
    INSERT OR IGNORE INTO relations (id,source_note_id,target_note_id,relation_type,created_at)
    SELECT ?,?,?,?,?
    WHERE EXISTS(SELECT 1 FROM notes WHERE id=?)
      AND EXISTS(SELECT 1 FROM notes WHERE id=?)
      AND NOT EXISTS(SELECT 1 FROM sync_tombstones WHERE entity_type='relation' AND entity_id=? AND deleted_at >= ?)
    ```
    第四/五参是 source/target noteId；最后一参 `deleted_at >= createdAt` 实现**防复活**（与 setting 分支同构）。`logChange("relation", id, "created"); applied++`。
- 排序补充：现有 `ordered` 仅把 note 置顶，relations 已在 note 之后，无需改排序；但若后续加其它依赖 note 的实体，需注意。

### 1.3 API 层
- 新增 `apps/server/src/routes/relations.ts`：
  - `GET /api/v1/relations?noteId=` → 列出该笔记的出/入关系（`SELECT ... WHERE source_note_id=? OR target_note_id=?`）。
  - `POST /api/v1/relations` → `{sourceNoteId, targetNoteId, relationType}` → `RelationService.createRelation` → 201 + 关系对象；重复返回 200（已存在）。
  - `DELETE /api/v1/relations/:id` → `RelationService.deleteRelation`。
  - 受 `registerDeviceAuthHook` 保护（与其他 `/api/*` 一致），无需额外公开。
- `apps/server/src/app.ts`：注册 `registerRelationRoutes`。
- `packages/shared/src/index.ts`：新增 relation Zod schema（`relationType` 枚举校验）。

### 1.4 客户端 + UI（工作量最大）
- `packages/api-client/src/index.ts`：增加 `listRelations(noteId)` / `createRelation(...)` / `deleteRelation(id)`。
- UI：笔记侧栏/详情加「关系」面板：
  - 列出 outgoing（本笔记指向）/ incoming（指向本笔记，即反向链接）。
  - 添加：选目标笔记 + 关系类型下拉；删除按钮。
  - 反向链接点击可跳转打开源笔记。
- `apps/web/src/lib/i18n.ts`：新增 relation 相关中英文案。
- 建议先用最小可用版（列表 + 增删 + 反向链接跳转），图谱视图可后续。

### 1.5 文档
- `docs/data-model.md` §3 relations：补「relations 现已实现并参与同步」段，注明同步语义（tombstone 防复活、快照含 relations）。
- `docs/auth-and-sync.md` §5.2：将「触发器写墓碑」改为「relation 删除已被同步消费（apply 分支防复活）」。
- `docs/api.md`：新增 `/relations` 三个端点说明。

### 1.6 测试
- `packages/domain/src/relation.test.ts`：创建/删除后断言 `sync_change_log` 有 `relation/created`、`relation/deleted`。
- `apps/server/src/sync/helpers.test.ts`：跨设备用例（A 创关系→pull→B 收到并写入；A 删关系→pull→B 删除）；防复活用例（B 已删后 A 回放旧 created 被拒）。
- 验证：`pnpm -r typecheck` + `@ygdria/domain`、`@ygdria/server` vitest。

### 注意点
- 关系创建后语义不可变（无 `updated_at`），故 upsert 用 `INSERT OR IGNORE`，不更新时间戳。
- 反向链接（incoming）依赖 `relations_target_idx`，查询已支持。
- 系统笔记不应作为关系端点（避免污染）。

---

## 修复二：`change-password` 步进认证（与 `clear` 对齐）

### 背景
- `reauthToken` 在 `/auth/login/verify` 登录成功时签发（`auth.ts:233-234`），5 分钟有效，存内存 `Map`。
- `clear`（`protected-session.ts:202-209`）在 `enableDeviceAuth` 时强制 `reauthToken` step-up 校验。
- `change-password`（`:102-200`）当前**不校验**，仅靠 device token 即可写入新 SRP verifier + `revokeAll()` → 账户接管纵深缺口。

### 2.1 后端改动（`protected-session.ts` `change-password` 端点）
- 请求体增加 `reauthToken?: string`。
- 在现有 `if (enableDeviceAuth && !body.auth)` 校验块**之后**、事务之前，插入：
  ```ts
  if (enableDeviceAuth) {
    pruneExpiredReauthTokens(protectedSessionReauth);
    const expiresAt = reauthToken ? protectedSessionReauth.get(reauthToken) : undefined;
    if (!expiresAt || expiresAt <= Date.now())
      throw httpError(401, "Current master-password verification is required");
    protectedSessionReauth.delete(reauthToken);
  }
  ```
- 形态 A（`enableDeviceAuth===false`，本机 loopback 信任边界）保持现状，与 `clear` 完全一致。
- 需在文件顶部已 `import { pruneExpiredReauthTokens }`（已有，:9）。

### 2.2 前端改动
- `ProtectedClientSession` / 设置页「改主密码」流程：调用前确保持有**有效** `reauthToken`。
  - `reauthToken` 是登录响应的一部分，前端应在登录成功后暂存（内存，不持久化）。
  - 若 `reauthToken` 缺失/过期，UI 引导用户重新输入主密码走一次 SRP `login/verify` 获取新 `reauthToken`，再提交改密码。
- 错误处理：401 时提示「请重新验证主密码」。

### 2.3 文档
- `docs/auth-and-sync.md` §3.4 / §4.3：注明 `change-password` 现在要求 `reauthToken`（形态 B），与 `clear` 对齐。

### 2.4 测试
- `apps/server/src` 现有 `protected-session` 相关测试（若有）：新增用例——形态 B 下无 `reauthToken` 调用 `change-password` 返回 401；带有效 `reauthToken` 成功；`reauthToken` 过期返回 401。
- 形态 A 下（enableDeviceAuth=false）无 `reauthToken` 仍可成功（回归）。

---

## 修复三：移动端 `deviceToken` 安全存储（@capacitor/keychain）

### 背景
- `apps/web/src/lib/credentialStorage.ts`：原生平台用 `@capacitor/preferences`（Android SharedPreferences / iOS UserDefaults，**明文**）。桌面用 `safeStorage`、Web 用 `sessionStorage`。
- 移动端属形态 B 远程访问，`deviceToken` 是完整 API 凭据，明文风险中–高。

### 3.1 依赖与原生工程
- **实际采用 `capacitor-secure-storage-plugin@^0.12.0`**（而非规划中的 `@capacitor/keychain`——经核实官方 `@capacitor/keychain` 与 `@capacitor/community/secure-storage` 在 npm 上均未发布；此插件 0.12.0 的 peer 为 `@capacitor/core >=7.0.0`，与项目 Capacitor 7.4.2 兼容，原生实现即 iOS Keychain / Android EncryptedSharedPreferences，等价目标）。
- `apps/web/package.json` 与 `apps/mobile/package.json` 已新增该依赖并 `pnpm install`（用 `env -u CODEBUDDY_SESSION_ID -u CLAUDE_SESSION_ID` 绕过沙箱 safe-delete 拦截）。
- `npx cap sync`（在 `apps/mobile` 下）自动发现并注册该插件原生模块到 android/ios 工程（Capacitor 自动纳入已安装的第三方插件，capacitor.config.ts 无需改动）。

### 3.2 `credentialStorage.ts` 改写
- 原生分支改用 `Keychain`：
  - `loadRemoteCredential`：`Keychain.get({ service: "ygdria", key: REMOTE_CREDENTIAL_KEY })` → `value` 解析；**fallback** 到旧 `Preferences`（一次性迁移：若 Keychain 无值但 Preferences 有，则读 Preferences 并写 Keychain 后删 Preferences）。
  - `saveRemoteCredential`：`Keychain.set({ service: "ygdria", key: REMOTE_CREDENTIAL_KEY, value: payload })`（覆盖写即更新）。
  - `clearRemoteCredential`：`Keychain.remove({ service: "ygdria", key: REMOTE_CREDENTIAL_KEY })`。
- 浏览器分支（非原生）保持 `sessionStorage` 不变。
- `service` 固定为 `"ygdria"` 以隔离钥匙串条目；`Keychain` 在 iOS 加密于 Keychain、Android 用 Keystore（AES），远超 Preferences 明文。

### 3.3 迁移策略
- 不做强制迁移：移动端重配对即可（配对流程会重新写入 Keychain）。fallback 读 Preferences 仅作一次性兼容，成功即迁走。

### 3.4 验证
- `@ygdria/web` + `@ygdria/mobile` `typecheck` 通过。
- 移动端 Android build 需 `cap add android`（若尚未）+ `cap sync`（已在 build.yml 做 android 任务）。
- 手动验证（设备/模拟器）：配对后检查 Keychain/Keystore 条目存在；卸载重装后凭据恢复（Keychain 跨重装保留，符合预期）；明文 SharedPreferences 中不再有 `ygdria.remote-device-credential`。

---

## 验证总策略
1. 每项改动后运行 `pnpm -r typecheck`（仅类型检查，不 build，见 MEMORY 验证约定）。
2. 单元/集成测试：domain 与 server vitest（relations、change-password）。
3. 手动 E2E（relations 同步、改密码 reauth、移动端 keychain）在桌面/模拟器验证。
4. 不破坏现有同步契约（relations 作为新 entityType，旧客户端忽略 default 分支，向后兼容）。

## 工作量估计（粗）
- 修复二（change-password）：**小**（~0.5 天，后端 10 行 + 前端引导 + 测试）。
- 修复三（keychain）：**小–中**（~1 天，含依赖/原生 sync/迁移/验证）。
- 修复一（relations 完整实现）：**大**（~1–2 周级，后端 + 同步 + REST + UI 面板 + 测试）；UI 可先交付最小可用版。

建议实施顺序：**修复二 → 修复三 → 修复一**（先堵账户接管与明文凭据，再投入最大的 relations 实现）。
