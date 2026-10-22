# 本地安全整改验证

2026-10-22，针对之前识别的同步解压入口和Linux SEA运行时风险完成本地修改。

- 自定义同步请求类型仅允许POST /api/v1/sync/push，保留gzip/identity输入，拒绝br及叠加编码。客户端原有gzip发送方式兼容。
- gzip改为异步、有maxOutputLength的解压，编码后/解压后均有大小上限，遵循更小的路由限制；响应gzip/br压缩同样改为异步。
- Node最低24.22.1，.nvmrc与CI一致；Linux SEA构建提前拒绝旧版本，输出含运行时、原生SQLite包版本和SHA256的build-info.json。
- 已验证：459项workspace测试和2项构建运行时守卫测试通过；全workspace类型检查、i18n lint通过。新增8项HTTP编解码测试覆盖压缩膨胀、拼接gzip、坏流/JSON、接口隔离、设备认证顺序及响应兼容性。
- 首次类型检查发现本机node_modules缺少锁文件已有的d3-force、类型包和Capacitor Camera；通过frozen-lockfile安装补齐，没有修改锁文件版本。
- 测试使用.git/toolchains/node-v24.22.1-win-x64中的独立SDK，官方ZIP SHA256已核对。本机全局Node仍24.18.0，没有替换系统安装；运行项目需先切换符合engines的版本。
- 未构建或部署Linux发布包，服务器旧SEA程序仍需后续更新；未提交或推送本轮改动。本次不代表已审计所有第三方依赖或Electron内嵌运行时。
