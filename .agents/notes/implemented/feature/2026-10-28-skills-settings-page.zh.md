# Agent Note: Skills Settings page

Status: implemented

[English](2026-10-28-skills-settings-page.md) | 中文

## 问题

skill 只能通过发现根目录到达模型和 `/` 菜单，用户唯一的控制手段是编辑文件或组合配置。用户无法看到 Host 加载了哪些 skill，无法关闭其中一个，也无法在浏览器里引入 skill 目录。注册表没有用户级的禁用标志，`skills/list` 以 Session 为地址且只列出用户可调用的 skill，而 `FileSystemSkillProvider` 只在构造时读取一次 `customSkillDirs`。

## 决策

新增 **Skills** 设置页 `@deepseek-ai/dsh-client-ui-settings-skills`，它注册 `settings.section`，id 为 `skills`，导航顺序 22，位于 Agent presets（20）与 Archived sessions（25）之间。页面列出每个已加载的 skill 并提供启用开关，另有“添加技能”，接收包含 `SKILL.md` 的目录的绝对路径。

状态保存在用户设置命名空间 `skills` 中，包含 `disabled: string[]` 与 `dirs: string[]`，对 Host 全局生效。`SessionSkillCatalog` 在 `skills` 与 `settings` 都存在时注册该命名空间，因此无需新增 Host 包：它已拥有 `skills` Remote 命名空间，并依赖注册表。

`SkillRegistry.setHiddenNames(source)` 是唯一的过滤点。`snapshot()`、`list()` 和 `get()` 在 `collect()` 之后、返回之前丢弃被隐藏的名称，且位于 collect 缓存之外，所以切换开关无需重建缓存，模型目录、`skill` 工具、`/name` 和 `/` 菜单保持一致。在合并之后过滤会让该名称彻底隐藏，同名的低优先级 skill 不会重新出现。`includeHidden` 让清单能列出已禁用的 skill。注册表仍与设置无关：来源由外部注入，所有者调用 `notifyHiddenChanged()` 发出 `skills/change`。

两个新 Remote 扩展现有的 `skills` 命名空间：`inventory`（无 Session 地址；列出无需工作区即可看到的 skill，带 `enabled`）与 `add`。`add` 要求绝对路径，用 `realpath` 解析 `SKILL.md`（因为提供方报告的是解析后的路径），把目录追加到 `dirs`，由于设置 scope 的 watcher 异步运行，所以显式使提供方失效，并在没有出现对应文件的 skill 时回滚这次写入。

添加的目录由 `user-added` 的 `FileSystemSkillProvider` 提供，它使用新增的 `singleSkillDirs` 选项：一个每次查找都会读取的函数，每个目录就是 `custom` 优先级下的一个 skill，列表变化时调用 `control.invalidate()`。

页面在挂载时（`load`）读取清单，而不是在插件 apply 时读取，因为冷启动 Remote 数量由启动预算固定；`connection/reset` 只在首次加载之后才会重新读取。开关通过已绑定的设置 scope 写入整个 `disabled` 数组，每行的 `enabled` 都由实时 scope 值重新计算。

## 考虑过的替代方案

**新建 Host 包 `skill-settings`。** 它能隔离设置接线，但约四十行依赖 Remote 自身服务的代码就需要包元数据、文档、生成的目录和 roster 条目；`SessionSkillCatalog` 本就处于这个接缝上。

**在每个消费方各自过滤。** `tool-skill` 的三处调用点和 Remote 的一处都要加同样的过滤，新增消费方也可能遗漏。注册表上的单一过滤无法被绕过。

**在 `collectFresh` 内部过滤。** 被隐藏的 skill 会作为缺失被缓存，每次切换都要重建目录；在缓存之后过滤能让缓存与用户偏好无关。

**启动时读取清单。** 这会给每次冷启动增加一个 Remote 请求，而多数会话从不打开这个页面。

**把添加的路径当作 skill 的父目录。** 这与 `customSkillDirs` 一致，但需求是添加单个 skill；按父目录扫描规则，包含 `SKILL.md` 的目录不会产出任何 skill。

## 影响

禁用按名称进行且全局生效：被禁用的名称也会隐藏同名的项目 skill，而清单因为不带工作区读取，所以不包含项目 skill。已添加的目录可以在页面上追加，但只能通过编辑设置文档来移除。路径由 Host 读取，所以远程浏览器添加的是 Host 上的路径，而不是本地文件。没有设置提供方时，禁用和添加不可用（`add` 失败；页面显示只读）。

## 测试

`packages/skill/skill/tests/skill.spec.ts` 固定了 `snapshot`、`list`、`get` 中的隐藏名称、`includeHidden`、变更事件，以及 disposer 只拥有自己的来源。`packages/skill/skill-filesystem/tests/skill-filesystem.spec.ts` 固定了单 skill 目录和失效后的重新扫描。`packages/api/session-controller/tests/session-skill-inventory.host.spec.ts` 用真实的注册表和文件设置提供方运行 Remote：添加、启用状态、禁用、拒绝、回滚与提供方丢失。客户端包测试固定了控制器合并、开关写入、挂载时加载与注册；`packages/client/ui-settings-general/tests` 与 `apps/web/tests/expected/settings-chrome/dialog-en.expected.md` 固定了导航项。

## 相关
