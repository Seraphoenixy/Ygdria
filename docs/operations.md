# 运行与维护

本页集中说明安装、启动、构建、数据库维护和诊断命令。数据结构与业务语义见 [data-model.md](data-model.md)。

## 1. 前置条件

- Node.js 24 LTS（24.x）。
- pnpm 10；项目通过 Corepack 固定版本。
- Windows 上若 `better-sqlite3` 需要从源码构建，安装 Visual Studio Build Tools 的 **Desktop development with C++** 工作负载。

若 `corepack enable` 因没有 `C:\Program Files\nodejs` 写入权限而失败，不必执行它；后续命令均可使用 `corepack pnpm ...`，无需全局安装 `pnpm`。

## 2. 首次启动

```powershell
# 安装所有 workspace 的依赖
corepack pnpm install

# 创建或升级 ./ygdria.db；该操作可以安全重复执行
corepack pnpm --filter @ygdria/database migrate

# 构建 React 产物，供服务端在同一端口提供
corepack pnpm --filter @ygdria/web build

# 启动完整应用，终端保持运行
corepack pnpm dev:server
```

应用地址为 `http://127.0.0.1:4318`。正常使用只需要服务端这一个进程。

## 3. 开发模式

修改 Web 界面时可另开终端执行：

```powershell
corepack pnpm dev
```

这会启动 Vite（通常为 `http://localhost:5173`），并把 `/api`、`/etapi` 代理到 `127.0.0.1:4318`。它只提供热更新，不替代后端服务，也不是正式运行所必需的进程。Vite 自动改用其他端口时，以终端显示的地址为准。

## 4. 构建与校验

```powershell
# 仅检查 TypeScript 类型，不生成产物
corepack pnpm typecheck

# 运行测试
corepack pnpm test

# 构建所有工作区
corepack pnpm build
```

修改 `apps/web` 源码后，只有要让 Fastify 单端口托管最新界面时才需要重新执行 Web build；使用 Vite 开发时不需要每次构建。

Electron 桌面应用使用单独构建命令：

```powershell
# 开发模式热更新
corepack pnpm --filter @ygdria/web dev:electron

# 生成 Electron 运行产物（同时构建 Web 界面）
corepack pnpm --filter @ygdria/desktop build

# 生成 NSIS 安装程序，输出在 apps/desktop/dist/
corepack pnpm --filter @ygdria/desktop dist:win
```

安装版会把 Web 界面与本地 API 一并打包；笔记数据库保存在当前 Windows 用户的应用数据目录，而不是安装目录。

Windows 桌面客户端只允许一个运行实例；再次打开时会聚焦已有窗口。内嵌 API 固定监听 `127.0.0.1:4318`，以保持本地界面与 ETAPI 的固定地址。若启动时该端口被占用，应用会显示“重试 / 退出”提示；关闭占用端口的程序后选择“重试”，不会自动切换端口。

Capacitor 移动端复用 Web 的构建产物；移动端包不单独包含 Vite 入口。构建并同步 Android 工程：

```powershell
corepack pnpm --filter @ygdria/mobile android
```

GitHub Actions 生成的 `linux-x64` 独立服务包内嵌 Node 24 运行时，目标服务器无需安装
Node.js、pnpm 或 tsx；解压后运行 `./start.sh`。首次启动会创建
`~/.config/ygdria/ygdria.ini`；数据库默认位于 `~/.local/share/ygdria/ygdria.db`，附件目录与其同级，不会写入解压后的发布目录。

## 5. 数据库与全文检索维护

```powershell
# 只读检查 FTS 投影
corepack pnpm check-search-index

# 从 notes 重建 FTS；会短暂取得 SQLite 写锁
corepack pnpm rebuild-search-index
```

重建命令只处理可再生的 `notes_fts`，不修改笔记正文或 revision。

### 5.1 在线维护任务（API）

服务端提供后台维护任务，无需停服：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/api/v1/maintenance/database?rebuildFts=true` | 启动后台任务：修剪 placement 撤销快照 + `VACUUM` + WAL checkpoint（可选 FTS 重建）。立即返回 `{ id }`。 |
| `POST` | `/api/v1/maintenance/search-index` | 后台触发 `notes_fts` 全文索引的完整重建任务，立即返回任务 ID；状态通过 `GET /api/v1/maintenance/status` 查询。 |
| `GET`  | `/api/v1/maintenance/status` | 查询当前或最近一次任务的状态与结果摘要。 |
| `GET`  | `/api/v1/maintenance/sync-status` | 只读容量报告：同步元数据（变更日志、墓碑、peer 游标、存储清理任务、placement 删除记录）的当前行数与保留原因，以及数据库页统计；返回 `{ stats, lastRun, peers }`。 |

任务在专用 SQLite 连接上运行，不阻塞主连接。约束：

- **互斥**：同一时刻只允许一个任务排队或运行；第二个请求返回 `409`。
- **冷却**：上次任务完成后 15 分钟内（`MAINTENANCE_COOLDOWN_MS`）拒绝新请求，返回 `429` + `Retry-After`。这防止维护接口被滥用为 DoS。
- **任务状态**：`queued` / `running` / `succeeded` / `failed`；失败时 `errorSummary` 记录错误类型与消息，不暴露堆栈。

此外，`sync_change_log` 表支持独立的在线剪枝操作：`pruneChangeLog()` 以所有 peer 的 `MIN(last_advance_id)` 为基准，删除所有 peer 均已确认的旧变更记录。该操作在应用启动时或空闲时间自动执行，不阻塞主连接。

### 5.2 离线备份与恢复（CLI）

`ygdria` CLI 提供完整备份与恢复，必须在服务端停服后执行：

```powershell
# 创建完整备份（数据库 + 附件），输出到指定目录
corepack pnpm ygdria backup [backup-dir]
# 默认备份目录：~/ygdria-backups

# 列出已有备份
corepack pnpm ygdria backup:list [backup-dir]

# 校验备份完整性（不写入）
corepack pnpm ygdria backup:verify <backup-directory>

# 从备份恢复到新目录
corepack pnpm ygdria restore <backup-directory> [restore-root]
# 默认恢复目录：~/.local/share/ygdria
```

备份内容包含 SQLite 数据库文件与 `attachments/` 目录；恢复时整体复制到目标目录，不修改源备份。

## 6. 完整性检查：`ygdria doctor`

```powershell
# 输出 JSON 检查报告；发现问题时退出码为 1
corepack pnpm ygdria doctor

# 修复可重建投影后再次检查
corepack pnpm ygdria doctor --fix
```

`doctor` 检查 SQLite、外键、正文与 revision、FTS、附件文件、placement 树和笔记类型。`--fix` 只重建 FTS 与 `plain_text`、重新编号 placement，并清理受控临时附件目录；不会自动修改正文、revision、附件元数据、关系或有环树。

执行 `doctor --fix` 前应停止服务端和其他数据库写入进程。默认附件存储根是当前工作目录，临时文件目录为 `<storage-root>/attachments-tmp`；如需检查其他目录，请使用命令参数调用相应的数据库工具。

## 7. 附件管理

```powershell
# 查看未引用附件数量
# 通过 API: GET /api/v1/attachments/unused/count

# 清除所有未引用附件并执行存储清理
# 通过 API: DELETE /api/v1/attachments/unused
```

附件服务提供 `cleanOrphanFiles()` 方法，可扫描孤儿文件并执行清理。应用启动时或空闲时间可调用此方法维护存储一致性。

## 8. 独立服务配置

运行时配置只读取 `~/.config/ygdria/ygdria.ini`，**不支持环境变量覆盖**。首次启动会自动生成：

```ini
[server]
port = 4318
host = 127.0.0.1
origin = http://localhost:5173
; 填写反向代理的 IP/CIDR；逗号分隔。未使用反代时保持为空。
trusted_proxy =

[storage]
database_url = /home/your-name/.local/share/ygdria/ygdria.db

[web]
web_dist =
```

`web_dist` 留空时使用随独立服务包提供的 Web 界面。若将 `host` 改为非 loopback 地址，必须在反向代理层配置 HTTPS。反代部署时，`origin` 必须是实际 HTTPS 站点源，并在 `trusted_proxy` 中只填写该反代的 IP/CIDR；同时防火墙必须拒绝公网直接访问 Node 监听端口。反代应强制 HTTPS、配置 HSTS，并限制请求体、连接数和登录接口速率。

### 8.1 就绪探针

`GET /api/v1/ready` 专为负载均衡/编排器探活设计：不限速、不要求认证，SQLite `SELECT 1` 与附件目录可创建均通过时返回 `200`，任一失败返回 `503`，不暴露内部错误细节。建议反代/编排器把健康探针指向此路径而非 `/api/v1/health`——后者还携带认证初始化状态，更适合应用层判断。

## 9. 设备认证与配对（形态 B）

独立服务始终启用设备认证，采用 **统一主密码派生 + PAKE（SRP-6a）挑战响应** 模型：用户只维护一个主密码，客户端从它派生 `fileKey`（用于受保护笔记）与 `accessSecret`（作为 SRP-6a 的“密码”取得设备令牌）。完整信任模型与同步边界见 [认证、受保护笔记与同步边界](auth-and-sync.md)；端点见 [API](api.md#11-设备管理与认证)。

```powershell
# 1. 启动服务器（设备认证已强制启用）
corepack pnpm dev:server

# 2. 用浏览器打开服务地址。首次访问会提示设置主密码（8–64 位 UTF-16 代码单元）：
#    浏览器本地生成 accessSalt、用主密码派生 accessSecret、运行 SRP 注册得到 srpSalt/verifier，
#    同时用同一主密码派生 fileKey 并生成 fileSalt/fileVerifier。
#    再 POST /api/v1/devices/initialize 提交 { accessSalt, srpSalt, verifier, fileSalt, fileVerifier, label }。
#    服务端在同一事务中写入 SRP 认证记录 + 受保护会话文件记录（不含主密码明文），
#    返回第一枚 deviceToken。受保护会话立即处于"已配置且已解锁"状态，无需单独设置文件密码。

# 3. 后续客户端输入同一主密码：
#    GET  /api/v1/auth/config           取 accessSalt/srpSalt 与 KDF 参数
#    POST /api/v1/auth/login/challenge  提交 clientPublicEphemeral，取得一次性 challengeId + serverPublicEphemeral
#    POST /api/v1/auth/login/verify    提交 clientSessionProof，校验通过后取得新的 deviceToken + serverSessionProof
#    （客户端必须用 serverSessionProof 执行互证，互证失败视为可疑中间人）

# 4. 也可由已认证设备签发一次性配对令牌，新设备不接触主密码：
#    POST /api/v1/devices/pairing-token  Header: Authorization: Bearer <deviceToken>
```

要点：

- 首次初始化完成前不要把反向代理开放到不可信网络；`initialize` 是一次性公开端点，谁先成功提交，谁就设定主密码与 SRP verifier。建议先经本机或受控隧道完成初始化，再开放公网入口。`initialize` 在同一事务中同时写入 SRP 认证记录和受保护会话文件记录，从初始化起文件密码与服务访问密码就统一——用户无需也不允许随后单独设置文件密码。
- 在设备认证模式下，`/api/v1/protected-session/setup` 和 `/api/v1/protected-session/change-password` 必须携带 `auth` 字段（官方客户端从同一主密码重新派生的 SRP 记录）。服务端拒绝不携带 `auth` 的请求，并在认证记录被替换时撤销全部设备令牌。本地桌面模式（无设备认证）保留原行为。
- 客户端登录前会校验服务端返回的协议/KDF 版本是否与客户端编译期常量一致，不一致时提示更新客户端。
- 主密码是**统一**的：同一个主密码既用于设备认证（派生 `accessSecret` 走 SRP），也用于受保护笔记的端到端加密（派生 `fileKey`）。两条派生路径使用独立的随机盐与上下文字符串（`ygdria/v1/access-secret`），互不复用。
- 服务端**绝不保存**主密码明文、`fileKey`、`accessSecret` 或 `deviceToken` 明文，也不接受它们作为请求体提交；`settings` 表只保存 `auth_access_salt`、`auth_srp_salt`、`auth_srp_verifier` 与协议/KDF 版本元数据。客户端也不持久化主密码或 `accessSecret`。
- 设备令牌仅存于服务器进程内存，**服务器重启后全部失效**；此外还有固定的 5 天滑动闲置超时（`DEVICE_TOKEN_IDLE_TIMEOUT_MS = 5 * 24 * 60 * 60 * 1000`）：超过 5 天未活动的令牌会在下一次校验时被立即删除并返回 `401`。重启或超时后需用主密码走 SRP 重新登录。
- 改密：在设置页输入当前主密码与新主密码后，客户端临时解密所有受保护笔记、用新主密码重新派生 `fileKey` 与 `accessSecret` 并重新运行 SRP 注册，把所有新密文 + 新文件 verifier + 新 SRP 记录通过 `POST /api/v1/protected-session/change-password` 一次提交；服务端在**同一事务**中原子迁移，事务成功后立即撤销所有现有设备令牌（包括发起改密的设备）。改密不会留下半完成状态。
- 登录失败**故意不区分原因**（统一返回 `401 Authentication failed`），避免泄露用户枚举或 verifier 状态。同一来源 IP 连续失败 5 次后暂停登录 30 秒（`429`）。
- 远端部署务必经反向代理强制 HTTPS；移动端只接受 HTTPS 端点。
- 撤销设备：`DELETE /api/v1/devices/:id` 撤销单个；`POST /api/v1/devices/revoke-all` 撤销除当前设备外的全部。

## 10. 移动端 Android 构建、签名与安装

`apps/mobile` 是 Capacitor Android 壳，复用 `@ygdria/web` 的构建产物（见 [§4](#4-构建与校验)）。**注意**：`pnpm --filter @ygdria/mobile android` 只执行 `cap sync`，**不生成 APK**；要出包必须借助 Android SDK 的 Gradle（`assembleDebug` / `assembleRelease`）或 `cap run android`。

Android 包会在构建时向系统注册 `SEND` 与 `SEND_MULTIPLE` 的 `image/*` 分享意图。因此相册中选择“分享”时，Ygdria 会出现在目标列表；接收的图片会被保存为一条新笔记。修改这项能力后必须重新构建并安装 APK，已安装的旧包不会自动获得该系统注册。

Android 拒绝安装**完全未签名**的 APK（报错「该安装包未包含任何证书」）。CI 的 `assembleRelease` 默认不签名，因此 `.github/workflows/build.yml` 的 Android 任务在配置了签名密钥后会用 `apksigner` 对 `app-release-unsigned.apk` 签名，产出可直接安装的 `Ygdria-android.apk`；未配置密钥时退回 unsigned 并在日志给出 `::warning::` 提示（该产物无法安装）。

### 10.1 本地调试安装（无需签名）

debug 构建由 Gradle 用默认 debug 密钥库自动签名，可直接安装到手机/模拟器：

```powershell
# 仅首次：生成 Capacitor Android 工程（需要本机已装 Android SDK 与 Android Studio 命令行）
corepack pnpm --filter @ygdria/mobile exec cap add android
# 连接设备/模拟器后，构建并直接安装 debug 包
corepack pnpm --filter @ygdria/mobile exec cap run android
# 或手动出 debug APK（装 app/build/outputs/apk/debug/app-debug.apk）
corepack pnpm --filter @ygdria/mobile exec cap sync android
cd apps/mobile/android && ./gradlew assembleDebug
```

### 10.2 正式发布签名（CI 自动签名）

准备密钥（在本机执行，**私钥不要提交仓库**）：

```powershell
# 1. 生成 keystore（按提示设置密钥库密码、密钥密码与别名）
keytool -genkeypair -v -keystore ygdria-release.keystore -alias ygdria `
  -keyalg RSA -keysize 2048 -validity 10000

# 2. 把 keystore 编码为 base64，用于 GitHub Secret
#    PowerShell：
[Convert]::ToBase64String([IO.File]::ReadAllBytes("ygdria-release.keystore"))
```

在仓库 **Settings → Secrets and variables → Actions** 新增以下 4 个 secret：

| Secret | 值 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | 上一步输出的 base64 字符串 |
| `ANDROID_KEY_ALIAS` | 别名（示例 `ygdria`） |
| `ANDROID_KEY_PASSWORD` | 密钥密码 |
| `ANDROID_STORE_PASSWORD` | 密钥库密码 |

配置后，下一次 CI 的 Android 任务会自动签名，`Upload Android APK` 产出的 `Ygdria-android.apk` 即可直接安装或分发。丢失 keystore 将无法更新已发布的应用（Android 要求同包名同密钥），请妥善备份。

### 10.3 本地手动签名 release

若不想走 CI，也可在本地用 `apksigner`（Android SDK build-tools 自带）对 `assembleRelease` 产物签名：

```bash
cd apps/mobile/android
./gradlew assembleRelease
"$ANDROID_HOME"/build-tools/<ver>/apksigner sign \
  --ks ~/ygdria-release.keystore --ks-key-alias ygdria \
  --out app/build/outputs/apk/release/app-release.apk \
  app/build/outputs/apk/release/app-release-unsigned.apk
```
