# @dsh-external/dsh-harness-leader-preset

一个 DSH **Agent preset**（不是插件、不是 skill 包）：把本机 DSH 会话变成「外部 harness 统筹官」——
选路、派发、跟踪、独立核验，而不是自己把活全干完。

它配合两个已经装在 **host 组合**里的插件工作：

| 插件 | 提供什么 | 本 preset 怎么用 |
|---|---|---|
| `@dsh-external/dsh-harness-pilot` | `harness_list` / `harness_models` / `harness_dispatch` / `harness_agent` / `harness_open` / `harness_send` / `harness_sessions` / `harness_spawn_teammate` / `harness_task_start` / `harness_task_status` / `harness_task_list` / `harness_task_cancel` | 不重复挂载——这些工具在 agent scope 里**已经可见**（宿主层的全局注册），本 preset 只负责把它们**用对** |
| `@dsh-external/dsh-model-connect` | 四条账号型 LLM 路由 `harness-workbuddy-cn` / `harness-workbuddy-intl` / `harness-qoder-cn` / `harness-qoder-intl` + 账号池 | 同上：只写进技能与 persona 的选路口径，不重复挂载 |

## 装了什么

```
cordis.patch.yml                  # bundle patch：插入一行 @deepseek-ai/dsh-agent-preset 声明
skills/
  external-harness-coordination/  # 本 preset 自带技能：工具矩阵 / 路由矩阵 / 模型引用 / 失败面 / 核验
validate-preset.mjs               # 用宿主自己的 YAML 方言 + 形状契约校验 cordis.patch.yml
resolve-skill-path.mjs            # 把技能目录的 !!js 表达式在六种运行期假设下求值，看是否落到真目录
tools/extract-asar.mjs            # 从运行中的 app.asar 抽取校验依赖（只读）
```

preset 的组成部分：

- **persona**（系统提示词里的 `deployment:persona` 段）：职责边界、固定工作流、以及「不许虚报」的硬约束。
  这是本 preset 的核心——它决定模型把「工具说成功」和「我核验过」分开。
- **agent-instructions**：加载工作区 `AGENTS.md` 链。
- **本地取证工具**：`tool-pwsh` / `tool-fs` / `tool-fs-search` / `tool-jobs`（leader 自己读文件、跑命令、看日志）。
- **技能**：`skill-filesystem` + `tool-skill`，其中 `customSkillDirs` 指向本包自己的 `skills/`。
- **计划/目标/压缩/交互**：`plan-mode`、`command-goal` + `tool-goal`、`compaction-basic` + `tool-result-pruner`、`tool-ask-user`、`tool-todo`、`tool-web`、`present`。
- **本地子代理与工作流**：`tool-subagent`（`modelSelectionSettings: true`）/ `tool-subagent-fork` / `workflow-ptc` + `tool-workflow` / `list-agents` + `tool-subagent-control`。

## 为什么 preset 里不写这两个插件

一句话：**它们的 `apply()` 只能在一个进程里跑一次。**

- profile 的 `dsh.profile.bundles` 已经把 `@dsh-external/dsh-harness-pilot` 与
  `@dsh-external/dsh-model-connect` 各挂载一次到 host 组合。
- 宿主契约明说 **subagent provider 名只能注册一次**；这两个插件在 `apply()` 里按全局唯一名注册
  provider、注册设置命名空间与 HTTP 面。preset 再挂一次 = 第二次按同名注册 = 未定义行为，
  而不是「多一份也无所谓」。
- 而它们的**工具**本来就在 agent scope 里可见（`agent → preset → global` 的父链里 global 在最远一层），
  所以「让本 preset 的 agent 看见 `harness_*`」根本不需要第二份注册。

结论：本 preset 只贡献**agent 平面**的东西（persona、技能、本地工具行的取舍），
插件本体留在 host 平面。校验脚本会把这条契约当硬规则检查（见下）。

## 安装

本机（desktop profile）已经装好，装载点如下：

```text
包本体      D:\Project\dsh-harness-leader-preset
profile     C:\Users\Administrator\.dsh\profiles\desktop
  package.json    dependencies += "@dsh-external/dsh-harness-leader-preset": "link:D:\\Project\\dsh-harness-leader-preset"
                  dsh.profile.bundles += "@dsh-external/dsh-harness-leader-preset"
  node_modules\@dsh-external\dsh-harness-leader-preset   → junction 到包本体
备份        C:\dsh-backups\harness-leader-preset-<时间戳>\{package.json,cordis.patch.yml,pnpm-lock.yaml}
```

**需要重启宿主**（bundle 的 patch 在启动时应用，profile 的 bundle 列表不在热重载范围内）。
重启后在新建会话的 preset 选择器里选 **外部 Harness 统筹官**（id `harness-leader`）。

想让它成为默认：在 profile 的 `cordis.patch.yml` 里把 `agent-preset-registry` 行的
`config.selectedDefault` 改成 `harness-leader`（该行现在的值是 `cordis`）。

换一台机器安装，等价的两条路：

1. 插件管理页（Settings → Plugins）安装本包；
2. 手工照上表做：junction + 两条 package.json 条目。
3. 回滚：删掉 junction 与两条 package.json 条目，重启；或用上面那份备份覆盖。

## 校验

```powershell
node validate-preset.mjs        # 宿主 YAML 方言 + preset 形状契约 + 本项目硬规则
node resolve-skill-path.mjs     # 技能目录在六种 baseUrl 假设下都落到真目录？
```

`validate-preset.mjs` 做两件事：

1. 用**宿主自己的 YAML 方言**解析 `cordis.patch.yml`——也就是 `yaml.JSON_SCHEMA` 扩展出 `!!js`
   标量（`@deepseek-ai/cordis-plugin-include` 的 `JsExpr`），因此 `!!js` 条件按宿主的方式解析，
   而不是当成未知标签失败。js-yaml 从运行中的 app.asar 抽取：

   ```powershell
   node tools/extract-asar.mjs "D:\DeepSeek\resources\app.asar" "dsh/node_modules/js-yaml" ".preset-validate\node_modules\js-yaml"
   ```

2. 检查形状与**本项目的硬契约**：preset 声明恰好一条、`config.id` 合法、`config.plugins` 非空、
   每个 group 行带嵌套列表，以及——`dsh-harness-pilot` / `dsh-model-connect` /
   `dsh-agent-preset-registry` **不得**出现在 preset 的 plugins 里。

`resolve-skill-path.mjs` 把 `customSkillDirs` 那条 `!!js` 表达式从真文件里解析出来，逐个假设
`baseUrl` 是 bundle 根目录 / profile 目录 / dshHome / app 目录 / 未定义，看结果是不是真的
`<包目录>/skills` 且里面能找到 `SKILL.md`。这一步是必要的：`!!js` 解析失败会拖垮整条 preset 行。

## 改这个 preset 时

- 改 persona 文案 = 改模型的默认工作方式。persona 在 agent 生命周期内**前缀稳定**，改动只对新会话生效。
- 想加「本地工具」就照随附 `standard` preset 的行抄；**要提供 service 的行必须放进带 `isolate` 的 group**，
  否则会发布进 root realm，被 preset 挂载审计拒绝。
- `customSkillDirs` 的 `!!js` 表达式必须写成**块标量**（`!!js |-`）。行内 `!!js xxx` 是 YAML 裸标量，
  里面出现 `node:path` 这种「键: 值」形状会被标量规则咬断，解析成畸形值（本包实测踩过两次）。
- 表达式必须 fail-soft：`process.env.DSH_PROFILE_DIR` / `DSH_HOME` 属兜底，任何一步抛错都要被
  `try/catch` 吞掉，因为 `!!js` 抛错 = 整条 preset 行加载失败。
