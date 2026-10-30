# Agent Note: 已归档会话页面的永久删除

Status: implemented

[English](2026-10-27-permanent-session-delete.md) | 中文

## 问题

已归档会话设置页可以恢复会话，却无法移除会话。系统中没有任何一层能删除 Session：`SessionPersistence` 只有 create、open、flush、stat 和 list，Workspace 注册表也只能在归档集合中增删 id。归档了大量会话的用户无法丢弃永远不会恢复的那些。

## 决策

`SessionPersistence.delete(id)` 是新增的抽象方法，擦除整个 Session，包括所有格式 generation。任何写句柄持有该 id 时以 `SessionAlreadyOwnedError` 拒绝，id 未知时以 `SessionPersistenceNotFoundError` 拒绝。JSONL 后端先取得进程内写声明与跨进程租约，清空冷日志备忘与迁移准备，把会话目录重命名为同级的 `~trash-<token>`，同步项目目录，再删除被重命名的目录。编码后的会话 id 把 `~` 转义为 `~` 加四位大写十六进制，因此任何 id 都不会与垃圾目录同名。重命名之后崩溃只会留下垃圾目录，列表会忽略它，下次启动会清扫；正是重命名避免了崩溃后某个较旧 generation 被当作该 Session 的当前日志。

已提交 generation 永不移动、覆盖或删除的规则约束的是格式迁移。`SessionPersistence.delete` 是唯一被许可的删除者，且总是删除整个 Session，而不是单个 generation。

`WorkspaceRegistry.deleteSession(id)` 在注册表操作链上运行：先从持久化删除，再从每个 Workspace 分离该 id、清除 header 与路径缓存，并把 id 从归档集合中移除。持久化未命中时仍会清理注册表。清理前失败时，Session 及其注册表条目保持不变；清理中失败则只留下成员过滤本就忽略的孤立 id。

`session.deleteSession` 是 Session Controller 上新增的 Remote，而不是 Workspace Controller 上的，因为 Client 还必须丢弃 Session 摘要，且 Session Controller 已依赖 Workspace 注册表。它以 `session/active` 拒绝在本 Host 中处于活动状态的 Session，把持久化的所有权冲突映射为同一错误码，调用注册表，尽力清除 `SessionProjectionCache` 记录，并发出现有的 `api-session/removed` 事件，使每个已连接的 Client 丢弃该行。Host 确认后，Client manager 也会在本地移除该行，durable subagent 同样如此。归档集合的变化经现有的 `archived` follow increment 到达 Client。

`UiWorkspace.deleteSession` 转发给 `ISessions.deleteSession`。已归档会话页面在取消归档之后新增删除按钮，打开 `Modal` 确认弹窗，初始焦点在“取消”；调用进行期间弹窗保持打开且按钮禁用，调用被拒绝时显示失败文本。

## 考虑过的替代方案

**隐藏而不是删除。** 仅在注册表中打标记会让日志留在磁盘上，操作就与其标签不符。

**按旧到新依次删除 generation 文件。** 中途崩溃会让 Session 处于半删除且仍可读的状态；先重命名目录，则从列表角度看删除是原子的。

**先 dispose 运行中的 Agent 再删除。** 停止进行中的 turn 需要目前没有任何 controller 拥有的取消并排空协议。第一版改为拒绝活动中的 Session。

**级联到 fork 出的子会话。** fork 会把继承的前缀复制进自己的日志，所以子会话从不读取父会话。子会话保留一个不再可解析的 `parentSession` id，Client 列表已能容忍这一点。

## 后果

删除是永久的，无法撤销。抽象方法 `delete` 是公共 API 变更，每个 `SessionPersistence` 后端和测试替身都要实现它。若缓存清理失败，已删除 Session 的 projection-cache 记录可能比它活得更久；该记录受身份校验保护，不会被提供给重新创建的同名 id。

## 测试

`packages/session/session-persistence/tests/contract.ts` 为每个后端固定删除、所有权拒绝、未找到拒绝和 id 复用。`packages/session/session-persistence-jsonl/tests/jsonl.spec.ts` 固定对所有 generation 的删除以及对遗留垃圾目录的清扫。`packages/workspace/workspace/tests/workspace.spec.ts` 固定注册表清理顺序及其失败情形。`packages/api/session-controller/tests/session-delete.host.spec.ts` 固定活动拒绝、错误映射与移除通知，`tests/sessions-service.client.spec.ts` 固定 Client 列表更新。`packages/client/ui-settings-unarchive-sessions/tests/components.client.spec.tsx` 固定确认、进行中、失败与重试路径。

## 相关

- [Session 取消归档设置页](2026-09-12-session-unarchive-settings-page.zh.md)——本次变更所扩展的恢复入口。
