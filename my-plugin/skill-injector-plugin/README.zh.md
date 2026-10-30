# skill-injector-plugin

[English](README.md) | 中文

一个 DeepSeek Harness 插件：**每个新会话开始的时候，自动把你在设置里配置好的技能(skill)加载到 Agent 的"记忆"里**，不需要每次会话都提醒 Agent 去用哪些 skill。

## 它是干什么的？

平时用 skill 的麻烦是：每个新会话里，Agent 不一定知道有哪些 skill 可用，你得反复提示它"用 XXX skill"。

这个插件把事情变成一次性配置：

1. 你在设置里，填好外部 skill 的路径（可以填多个）。
2. 从**下一个新会话开始**，每次会话一开启，插件就会把这些 skill 的完整内容自动注入到 Agent 的上下文里。
3. 所以 Agent 一开始就"已经知道"这些技能，不用你再提示。

## 怎么用

### 第一步：安装（已装好则跳过）

在 dsh 仓库目录执行：

```sh
dsh plugin --profile web add /Users/jdong/iproject/dsh/my-plugin/skill-injector-plugin
```

然后重启 dsh（比如运行 `dh-web`）让插件生效。

### 第二步：配置技能路径

在 DSH 的**设置文档** `~/.dsh/settings.yaml` 里加上（或编辑已经存在的）`skill-injector` 一节，填上技能目录路径：

```yaml
skill-injector:
  skillPaths:
    - /Users/jdong/AI-D/AI-D-OB/Zuora/Dz-agent/skills
```

改完**即时生效**（settings 文件是热加载的），新开一个会话即可看到注入效果。

> 说明：本插件是运行在命令行的 host 插件，它注册的 `skill-injector` 命名空间目前**不会在 DSH 的图形设置界面里显示**（GUI 的配置卡片需要额外的客户端组件和重新构建 web 前端，暂未实现）。所以直接在 `settings.yaml` 里配即可。

> `skillPaths` 的每一项可以填：
> - 一个"装了很多技能"的目录（推荐，比如上面那个 skills 目录）
> - 一个单独的技能目录（里面有 `SKILL.md`）
> - 一个单独的 `.md` 技能文件

### 第三步：开始用

开一个**新**会话，直接说你想做的事就行，Agent 会自动使用你配置的这些技能。

## 配置项（可选）

在插件的 `cordis.patch.yml` 里可以调：

| 配置 | 默认值 | 作用 |
|---|---|---|
| `enabled` | `true` | 总开关，`false` 时插件什么都不做 |
| `maxBytes` | `131072` | 注入内容的大小上限（字节）。技能太多太大时可以调小 |

## 文件在哪

```
my-plugin/skill-injector-plugin/
├── src/index.ts          # Plugin source
├── dist/                 # Compiled output
├── package.json          # Package definition
├── cordis.patch.yml      # How it mounts into a profile
└── smoke.test.mjs        # Local smoke test
```
