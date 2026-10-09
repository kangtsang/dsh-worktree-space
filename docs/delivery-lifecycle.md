# 任务空间交付生命周期设计 — 从「改完代码」到「合并回源分支」

状态：**设计稿 v1.1 — Q1–Q6 已全部决策（2026-10-05），待实测**。读者：维护者（复审与调整决策）、实现会话（按本文落地）。
范围：`dsh-worktree-space` 插件的任务交付生命周期，以及它与部署验收能力（4 服务 demo 已验证
的 deploy.sh / compose / 冒烟约定）的衔接。已实现部分标注了提交号，未实现部分是计划。

相关文档：使用者指南见 [delivery-guide.md](delivery-guide.md)（面板用法、策略配置、清单编写、错误码）；agent 指引见捆绑 skill。

相关基线：
- L0 已实现：task/docker 分支 `ed4b121`（naming.js / shared.js / SKILL.md / 测试）
- 部署参考实现：`E:\workspace\public\docker`（4 个独立服务仓库 + `deploy/` 编排根）
- 宿主验收基础设施：本仓库 `scripts/acceptance/`（受控沙箱里安装 / 启动 / 回滚多个 DSH 版本）

---

## 0. 目标与不变量

**目标一句话**：agent 在任务空间里改完代码后，按创建时确定的交付策略，自动走到
「部署 → 验收 → 交付（合并回源分支）→ 清理」的终点；每一步可自动化，每一步也可被策略拦下交给人。

四条不变量，任何实现不得违背：

1. **职责分界**：agent 拥有「怎么做」（执行仓库自己的部署脚本、写代码、跑验证）；
   插件拥有「何时 / 何物」（环境身份、生命周期闸门、状态可见性）。插件永远不学习
   如何构建某个应用——那是仓库部署契约的事。
2. **永不 push**：合并只发生在本地源仓库；推远端永远是用户自己的动作（仓库约定）。
3. **破坏性步骤可配置自动，默认人审**：合并、删分支、删产物三类动作都有策略项，
   默认值落在人审一侧；全自动必须显式开启。
4. **握手协议是数据，不是代码**：插件与部署脚本之间只通过三个约定通信——
   `dsh.env-id` 容器 label、`DSH_ENV_ID` 环境身份、`.state.json` 状态文件
   （字段见 §3.3）。除此之外互不依赖内部实现。

---

## 1. 生命周期总览

```
created ──► developing ──► deploying ──► verifying ──┬─► awaiting-human ─┐
   (创建时注入策略)        │(策略=auto 才进)          │                   │
                          │                          │(verification=agent)│
                          ▼                          ▼                   ▼
                       (按需部署)                 验证失败 ──► 回 developing
                                                 验证通过 ──► deliverable
                                                                 │
                                          done：merge(按策略) ◄──┘
                                                 │
                              ┌──────────────────┼──────────────────┐
                              ▼                  ▼                  ▼
                          遇到冲突            干净合并            有 stray 产物
                       conflicts=ask/agent     deleteBranch      strays=archive
                       → resolving ──► 再次 done   │                 │
                                                    ▼                 ▼
                                            清理环境（按 label 销毁）─► done
```

| 阶段 | 执行者 | 动作 | 记录在哪 | 失败行为 |
|---|---|---|---|---|
| created | 插件 | 写 json + md + 策略 | `worktree-space.json` | 创建回滚（已有） |
| developing | agent | 正常开发提交 | git | — |
| deploying | agent | 执行部署契约（§3） | `.state.json` | 冒烟/日志定位后修复重来 |
| verifying | agent（+人） | 冒烟 + 自验（+人工 ack） | `.state.json` 的 `lastSmoke` | 不进交付 |
| deliverable | — | 闸门判定（§5.1） | — | 停在 verifying |
| merging | 插件 `done` | 预演合并 → 真合并 | 任务计划/面板 | 冲突按 §6 |
| cleaning | 插件钩子 | 按 `dsh.env-id` label 销毁环境 | docker | docker 不在场静默跳过 |

设计取向：**没有独立的流水线引擎**。所谓状态机就是 agent 按 skill 指引走完这些步骤，
插件只在两处强制：`done` 的交付闸门（§5.1）和收尾清理钩子（§8）。

---

## 2. 创建时注入：任务空间「生而有之」的东西

已实现（L0，`ed4b121`）：

- `worktree-space.json`：任务身份 + 起点事实 + `deploymentEnvId`（从 project+task 推导，
  规则见 `naming.js deploymentEnvIdFor`，形如 `dsh-public-docker`）。
- `worktree-space.md`：同一记录的可读版，含 `## Deployment` 段——给会话一行可复制的
  `DSH_ENV_ID=...` 与部署命令约定。老记录（无该字段）不渲染此段。
- 捆绑 skill 的「Deploying for acceptance」章节：何时部署、可部署形态、先冒烟再交地址。

**待实现：`delivery` 策略块**，创建时写进 JSON 并渲染进 note：

```jsonc
"delivery": {
  "version": 1,
  "deploy": {
    "target": "docker",          // docker | host | dsh-acceptance | none
    "mode": "auto"               // auto | on-request（auto=改完即部署；on-request=用户说了才部署）
  },
  "verification": "human",         // agent | agent-then-human | human（决策 D1：默认 human）
  "merge": {
    "mode": "ask",               // auto | ask | never（决策 D3：auto 必须显式开启）
                                 //   auto = 这份记录说"这条任务自己合回去"：收尾不必再传 merge。
                                 //   auto 不能与要人验证的模式共存（auto + agent-then-human/human 在建任务时就被拒绝，
                                 //   因为 auto 没有人可等）；要人验证就用 ask + agent-then-human/human。
                                 //   never = 这条流程不合并这条任务：工具传 merge: true 会被拒绝（E4013）。
    "target": null,              // null=各源仓库当前检出的分支；可指定如 "develop"
    "deleteBranch": false        // 合并成功后是否删任务分支；默认 false=保留，只有写 true 才删
  },
  "conflicts": "ask",            // agent-auto | ask | stop（决策 D2：默认 ask）
  "strays": "archive"            // archive | keep（没有 discard：删除只由调用方旗标决定）
}
```

策略如何确定：创建流程（工具的 `create` 动作 / 面板对话框）**询问一次**，之后把该项目的
答案存为**插件配置里的项目默认值**（项目名做 key，与「容器根」同一种「用户的固定回答」
机制——决策 D9），同一项目建第二个任务时不再重复问，答案仍可逐项覆盖。策略渲染进
`worktree-space.md` 的新 `## Delivery policy` 段，agent 全程以它为准，不做临场判断。

---

## 3. 部署：目标可插拔（决策 D4）

**部署目标 = 验收载体的类型，由交付物决定，而不是只有 docker 一种**：

| target | 适合的交付物 | 载体 | 隔离性 | 现状 |
|---|---|---|---|---|
| `docker` | 自成体系的服务组（如 4 服务 demo） | compose 环境，动态端口 | 容器级隔离 | ✅ 已跑通（L0） |
| `host` | 脚本、CLI、单进程小工具 | 用户本机直接运行 | **无隔离**，占用真实端口/环境 | 待定义契约 |
| ~~dsh-acceptance~~ | ~~DSH 插件~~ | 已移除（2026-10-07）：插件验收也是 docker 承载的网页实例，见 §3.2 修订 | — | — |

### 3.1 部署清单（manifest）——定稿形态（决策 D12）

任务空间的 `deploy/` 根（agent 搭建，或仓库自带）里放一份**按目标声明的清单**：

```yaml
# deploy/deploy.yaml（定稿）
targets:
  docker:
    up: ./deploy.sh up          # 现有 compose 方案原样接入
    smoke: ./deploy.sh smoke
    status: ./deploy.sh status --json
    destroy: ./deploy.sh destroy
  host:
    up: make run                # 仓库自己声明怎么在本机起
    verify: make check          # 本机形态的验收命令
    destroy: make stop
    autoAllowed: false               # 决策 D8：host 默认禁 auto，显式 true 才豁免
  dsh-acceptance:
    up: ../scripts/acceptance/ 单最新版验收入口   # 决策 D7：只对最新 DSH 版本
    verify: store-evidence 清单
    destroy: 卸载回滚
```

要点：
- **清单由仓库/任务空间声明自己支持哪些目标**；策略里选了清单没有的目标 → 明确报错，
  绝不静默换目标（用户要的是 DSH 沙箱验收，agent 不许自作主张改用 docker 交差）。
- 每个目标自带 `up / verify / destroy` 三段契约；`verify` 可以不同——docker 跑冒烟，
  dsh-acceptance 跑 store-evidence 式的安装/可见/卸载清单，host 跑仓库自己的检查。
- 过渡期兼容：只有 `deploy.sh`（无清单）的任务空间视作仅支持 `docker` 目标。

### 3.2 各目标的风险与默认权限

- `docker`：隔离最好，可 `auto`。
- `host`：无隔离——占用真实端口、写真实数据目录。**默认禁止 auto**，但 deploy.yaml
  对该目标显式标 `autoAllowed: true` 可豁免（决策 D8）——想开的人显式担责。

**`dsh-acceptance` 已从目标类型移除**（2026-10-07 修订）：调研确认 DSH 验收实例
本身是纯 Node 进程（`dsh web --port`）提供网页验收，插件经 `dsh plugin add` 装入，
无平台约束——它完全可以由 docker 承载。所谓 DSH 插件验收，是 `docker` 目标的
一个**配方**：清单的 up 指向一个装好指定版本 DSH 与插件 tarball 的镜像启动命令，
DSH 版本是配方的参数（原 D7 的单最新版语义由此保留）。`scripts/acceptance/`
保持原有角色：宿主侧的手工验收与发版矩阵基础设施，不进流水线类型系统。

### 3.3 状态文件契约（已实现部分）

`${DSH_STATE_FILE:-<deploy根>/.state.json}`，由部署脚本独占写入：

```jsonc
{
  "envId": "dsh-public-docker",        // = DSH_ENV_ID 折叠后 = compose 项目名 = label 值
  "url": "http://localhost:51454",     // docker 目标的验收地址；其他目标可为 null 或换语义
  "deployedAt": "…", "updatedAt": "…",
  "lastSmoke": { "at": "…", "result": "pass" },   // 交付闸门读这里
  "services": [{ "name": "…", "state": "running", "health": "healthy" }]
}
```

`docker deploy.sh status --json` 输出同一结构（已实现）。`dsh.env-id` label 已在 compose
四个服务上打好（已实现），发现/清理一律按 label 过滤，不解析项目名。

---

## 4. 验收：agent 自动 + 人工（决策 D1）

`verification: agent | agent-then-human | human`，**默认 `human`**（2026-10-09 由维护者从 `agent-then-human` 改成它：验收本来就是人的判断，默认不指望 agent 自验；agent 那层把握仍在，只是不再是默认口径）。

- **agent 能验的**：部署健康（state 文件里 services 全 healthy）、接口冒烟（smoke 契约）、
  以及会话工具能力范围内的点击级验证（浏览器工具走一遍页面）。这一层验「接线正确」。
- **人验的**：「功能做得对不对、好不好」。`agent-then-human` 下，agent 冒烟通过后把
  URL + 「点哪里看这个改动」报给用户（控制台卡片 + 会话消息），状态停在
  `awaiting-human`；用户的 ack 动作（面板按钮，L1）才点亮 deliverable。
- **`agent` 全自动**只建议用于纯接口类任务；策略里选它 = 用户明说过不需要人工验收。
- 验证失败的出口永远回 `developing`：`deploy.sh logs <service>` 是第一现场（skill 已写明）。

---

## 5. 交付与合并

### 5.1 可交付定义（交付闸门）

`deliverable = 工作区全部已提交 && lastSmoke.result == "pass" && (verification != agent-then-human || 人工 ack)`

**实现为 `done` 的策略校验**：`delivery` 要求验证的任务，`done` 带 `merge` 时先读
`.state.json`——`lastSmoke` 缺失或非 pass 则拒绝合并，报「先部署验收」。这是插件
强制、agent 绕不过的一环；绕过只能靠策略把 verification 关掉，而那是用户的显式决定。

### 5.2 合并（决策 D3，已确认按建议执行）

`merge.mode: auto | ask | never`，`target` 可指定（默认各源仓库当前检出分支）。

- `auto` **必须显式开启**（按项目配置一次），且只在闸门全绿时执行；预演合并
  （对向预检）沿用现有机制，预演出冲突就走 §6。
- **目标分支被检出在用户工作副本时：照样就地合并**（决策 D10，2026-10-05 拍板——
  追求全自动，接受改动检出副本的风险）。安全垫保留：预演合并仍然先行，预演出冲突
  停在任务空间里不动目标；目标检出区自身有未提交改动时的拦截行为沿用现有 `done` 检查。
- 合并成功后 `deleteBranch: true` 才删任务分支；abandon 路径（不合并强删）永远保持人审。
- 合并只落本地源仓库，**永不 push**（不变量 2）。

---

## 6. 冲突处理（决策 D2：默认 ask）

机制全部已存在：预演合并把冲突留在任务空间自己的 worktree 里（MERGE_HEAD + 冲突文件），
面板「Hand the conflict to the agent」开一个覆盖全部冲突仓库的会话，agent 解决并提交合并，
下一次 `done` 免预演直接真合并。

- `conflicts: ask`（默认）：自动化停在这里，等用户按键开会话。理由：解决冲突是替用户
  做取舍，且提交合并会写源仓库 `.git`、可能需要会话内提权——这正是插件把冲突标为
  beta 的原因。
- `conflicts: agent-auto`：冲突会话**自动触发、解决后自动再次 done**。作为策略项存在，
  供低风险项目实测后开启；提权需求必须显式浮出，不许静默重试。
- `conflicts: stop`：遇冲突冻结流水线，只报告。

---

## 7. 未受 git 管理的生成物（strays）

现有 `done` 已带完整归档机制（决策 D11：**复用，不新设计**）：

- **用户自己的内容**（documents）：拷出到调用方/配置指定的 documents 目录——
  `cp` 成功才删原件、拷贝失败保留原物并告警（archive.js 现行为）。
- **构建产物 / 编辑器状态**：由 `cleanStray` 另行处理，默认保留、用户挑了才清。

策略化后：`strays: archive` = 收尾时对这两类**自动按上述现有默认走**（内容进归档目录、
产物按 cleanStray 清理），不再等逐项挑选；`keep` = 维持现状（列出让用户挑）；
`discard` 不在策略里：丢弃是调用方的 `discardDocuments` 旗标，只有 abandon 路径会传，因此"由策略删掉用户文件"这条路根本不存在。归档是拷出后清理，任何失败都不丢原件。

---

## 8. 清理：环境销毁钩子（L1）

任务 `done` 完成（合并 + 删分支按策略）后，插件执行 best-effort 清理：

```
docker ps --filter label=dsh.env-id=<deploymentEnvId> → docker compose -p <envId> down -v
```

- 按 label 找环境，不解析 compose 文件、不依赖脚本存在；找不到 = 本来就没部署，静默结束。
- docker 不可用 / 超时 → 警告一次，**绝不阻塞任务收尾**。
- 验收中途用户想手动拆：控制台卡片上的「销毁」按钮（L1）走同一条 label 路径。

---

## 9. 实施计划与状态

| 步骤 | 内容 | 涉及 | 状态 |
|---|---|---|---|
| L0 | 约定注入：env id + note Deployment 段 + skill 部署章节 + `status --json` / `.state.json` / label | naming.js、shared.js、SKILL.md、deploy 脚本 | ✅ `ed4b121` |
| L1.1 | `delivery` 策略块：schema、解析（显式 > 项目默认 > 内置）、note 渲染 `## Delivery policy`、配置字段 `deliveryDefaultsJson` | delivery.js（新）、shared.js、create.js、index.js、tool.js | ✅ `8d35484` |
| L1.2 | 交付闸门：`finishTask` 内所有路径强制，读策略 + `.state.json`（E5005 无记录 / E5006 冒烟未过 / E5007 等人工 ack） | deploy.js（新）、archive.js、codes.js | ✅ `8d35484` |
| L1.3 | 清理钩子（done 成功后按 label 销毁，compose down 优先 rm -f 兜底，永不致命）+ 三个端点 + 控制台部署卡片（URL/冒烟徽章/确认验收/销毁，中英文案） | deploy.js、archive.js、index.js、DeployCard.tsx、api.ts、i18n.ts | ✅ `8d35484` |
| L1.4 | 部署清单：deploy.yaml 受控解析（契约两层结构）、目标分派（up/smoke/destroy 命令经 DSH_ENV_ID 执行）、目标不匹配报错（E5009/E5010）、status 暴露 targets+autoAllowed、无清单兼容 L0 仅 docker。dsh-acceptance 目标=清单里写命令即可（无需硬编码）；autoAllowed 的流水线钳制落在指引层（D8） | deploy.js、codes.js | ✅ 本次（dsh-acceptance 的 PowerShell 入口对齐待实测后调） |
| L2.1 | strays 策略接线：archive 自动归档（applyStraysPolicy 纯函数 + deliveryArchive 参数）/ keep = 策略不表态（什么都不删）。**策略不含 discard**——删除只由调用方 `discardDocuments` 旗标（仅 abandon 路径）决定 | delivery.js、archive.js、index.js、tool.js | ✅ 本次（discard 已从策略层移除） |
| L2.2 | 冲突 agent-auto：策略经 note/tool description 暴露给调用方，agent-auto 时 agent 自动解决冲突、提交合并并重试 done（提权需公开请求）；无新机制 | SKILL.md、tool.js | ✅ 本次 |

### L1 实现时按推荐取的默认决策（待维护者核对）

- **全局默认策略 = 交付关、验收靠人、遗留内容归档**（target `none` / mode `on-request` / verification `human` /
  merge `ask` / conflicts `ask` / strays `archive`）：不部署、不自动合并、不自动删除用户内容，验收默认只由人确认；
  **遗留内容默认归档**——归档是复制一份，内容不会因为它离开任务空间而丢失，而任务空间因此能在一次收尾里被清掉。
  启用其它口径靠项目默认配置。
- **项目默认存储**：配置字段 `deliveryDefaultsJson`（JSON 文本，Plugins 页可直接编辑；
  专用 map 编辑控件留待后续）。
- **人工 ack 语义**：写进 `.state.json` 的 `humanAck`；`up`（新部署）清空、`smoke`（同部署
  重跑）保留、`destroy` 随文件删除；ack 只能经 `task.deploy-accept` 端点由面板按钮写入。
- **策略不是模型参数**：tool 的 create 不接受 policy 字段，模型创建的任务走项目默认，
  与面板创建殊途同归；闸门错误 E5005-7 已入 PUBLIC_ERROR_CODES，模型可见可据以行动
  （部署→冒烟→请用户 ack），但绕不过。
- **DeployCard 挂载位置**：任务卡 header 与 worktree 列表之间；策略 target 为 none 且
  无状态文件、无容器时整卡隐藏。
- **状态文件三段所有权**：部署脚本写/改（up、smoke、destroy），面板只追加 `humanAck`，
  插件清理只删文件——所有权边界写进了 deploy.js 的模块注释。

顺序原则：先把整条流程**串通**（L1.1→L1.3，用 docker 目标），实测后再优化（用户指示 D6）；
新目标契约与自动化增强放在实测反馈之后。

---

## 10. 决策记录

已确认的决策（用户拍板）：

- **D1** 验收默认 `human`——验收本来就是人的判断，默认不指望 agent 自验；`agent-then-human`（agent 冒烟验接线 + 你验产品）仍是可选项。（2026-10-05 原定 `agent-then-human`，2026-10-09 由维护者改为 `human`）
- **D2** 冲突默认 `ask`；`agent-auto` 作为策略项后置。（已确认）
- **D3** 自动合并需策略显式开启，闸门全绿才执行；永不 push；abandon 路径永远人审。（已确认）
- **D4**（修订 2026-10-07：目标收敛为 docker / host / none）部署目标可插拔：清单声明支持范围，
  目标不支持就报错，绝不静默换目标。（用户新增需求）
- **D5** 环境身份 = `dsh-<slug(project)>-<slug(task)>`，三处（note / 脚本 / label）共用
  一条折叠规则。（L0 已实现）
- **D6** 先串通全流程，实测后再优化各环节。（用户指示）
- **D7**（修订 2026-10-07：原独立的 dsh-acceptance 目标类型移除，语义并入 docker 配方——DSH 版本是配方参数，仍只对**最新 DSH 版本**验收）全矩阵（run-all）是发版动作，
  不进任务交付流水线——与现有人工验收习惯一致。（Q1，2026-10-05 拍板）
- **D8** `host` 目标默认禁止 auto；deploy.yaml 对该目标显式 `autoAllowed: true` 才豁免。（Q2，拍板）
- **D9** 项目级默认策略存**插件配置**（项目名做 key，创建对话框"记住为该项目默认"），
  与容器根同一机制。（Q4，拍板）
- **D10** auto 合并遇目标分支被检出在用户工作副本：**照样就地合并**；预演合并仍先行，
  目标检出区未提交改动的拦截沿用现有 `done` 检查。（Q3，拍板）
- **D11** stray 归档**复用现有机制**：用户内容走 documents 目录（拷出→成功才删→失败保留），
  产物走 cleanStray 现有行为；不新设归档位置。（Q5，拍板）
- **D12** 部署清单用 **`deploy.yaml` 声明式**；只有 `deploy.sh` 无 yaml 的空间视作仅
  docker 目标（L0 兼容）。（Q6，拍板）

开放问题：v1 审阅已全部关闭（Q1–Q6 → D7–D12）。实测中发现的新问题在实测后追加于此。
