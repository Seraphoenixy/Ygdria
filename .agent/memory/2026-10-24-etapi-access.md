# 2026-10-24 本机 AI 与外部访问简化

用户明确要求前端与功能精简为开关，替代先前的多会话令牌模型。

- 桌面设置只提供本机外部访问开关，默认关闭；GET/PATCH /api/v1/etapi/access，桌面私有 etapi-access.json 保存状态。
- ETAPI 不使用 bearer/scope/有效期。请求需 X-Ygdria-External-Access: 1，实际 socket 与 Host 均为 loopback，无 Origin 或 Sec-Fetch-Site。
- 旧 session 签发/列表/撤销接口和实现已移除，旧文件不再读取。升级后默认关闭。
- MCP 无需 token/allowWrite；旧配置字段忽略，所有工具注册，执行由主应用开关控制。关闭再开启不必重启 MCP。
- 幂等 receipt 使用稳定 local:create / local:operation:<noteId> 范围，切换开关不改变范围；仍保留 30 天。
- 验证含服务端权限与持久化测试、MCP 测试及实际 HTTP 集成：开关、创建、追加去重和重新关闭。
