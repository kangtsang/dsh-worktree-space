# 交付流水线使用指南

本文是任务空间交付流水线的**使用者指南**：面板怎么用、策略怎么配、清单怎么写、
出错怎么读。设计原理与决策记录见 [`delivery-lifecycle.md`](delivery-lifecycle.md)，
agent 的工作流指引见捆绑 skill（`task-worktree-space`）。

前提：任务空间由 Worktree Space 插件创建（任务分支上的提交、源仓库只读），
交付策略在创建时随任务记录进 `worktree-space.json` 与 `worktree-space.md`。

---

## 1. 面板：部署卡片

每个任务卡的 header 下方是一张部署卡片，任务从未部署过时整卡隐藏。它每次
**实时查询**——docker 按容器 label 查运行状态，部署状态文件查验收事实——
不缓存任何东西。

| 元素 | 含义 |
|---|---|
| 验收地址 | 点击在新窗口打开；动态端口随每次部署变化，以卡片显示为准 |
| 冒烟徽章 | `● 冒烟通过 <时间>` / `● 冒烟失败 <时间>` / `未冒烟`。时间是审计日志格式（本地 `YYYY-MM-DD HH:mm:ss`） |
| 人工验收徽章 | `● 已人工验收 <时间>` / `● 未人工验收`。你点「确认验收」后写入 |
| 运行中容器 | 按 `dsh.env-id` label 实时数出来的容器数 |
| 刷新 | 重查以上全部（纯只读） |

操作按钮按状态出现：

| 按钮 | 出现时机 | 做什么 |
|---|---|---|
| **部署验收** | 容器不在（已销毁或从未部署） | 执行任务空间自己的 `deploy.sh up <envId>`——`--build` 重新打包改动源码，重建后**验收事实（冒烟/人工确认）保留**，只有验收地址刷新 |
| **执行冒烟** | 容器运行中 | 执行 `deploy.sh smoke <envId>`——6 步接口冒烟（网关转发→401 拦截→注册登录→商品列表→下单扣款→余额核对），**失败也是结果**：红色徽章+时间戳照样刷新 |
| **确认验收** | 冒烟通过且未确认 | 写入人工确认（`humanAck`）——agent-then-human 策略下合并的必要条件 |
| **销毁环境** | 容器运行中 | 两段确认（第一次点变「确认销毁」，再点执行）：按 label 拆容器/网络/卷。**验收事实保留**，只失效地址并盖销毁时间戳 |

改代码后的循环：**部署验收（重新打包）→ 执行冒烟 → 通过后确认验收 → 结束任务**。

## 2. 结束任务与交付闸门

「结束任务」= 移除 worktree + （按策略）合并回源分支 + 删分支 + 按策略清理生成物
+ **自动销毁部署环境**（清理钩子，永不阻塞收尾）。

合并前闸门按策略校验（读部署状态文件）：

| 闸门 | 条件 | 表现 |
|---|---|---|
| 策略部署了东西但状态文件不存在 | `E5005` | 先部署 + 冒烟 |
| 冒烟未通过或未跑 | `E5006`（仅缺冒烟时）/ `E5007`（连带缺确认） | 跑冒烟、请人验收 |
| agent-then-human 且无人工确认 | `E5007` | 面板点「确认验收」，或二次确认框点「继续」 |

**用户指令最高**：点「结束任务」遇到未满足的闸门时，弹一句式确认框——
「尚未完成冒烟验证和人工验收确认，是否要结束任务？」——继续则带确认合并
（日志记一条 warning），取消则返回。agent（模型）没有这个跳过通道：它面对
的是硬闸门，出路只有部署→冒烟→请人验收。

## 3. 交付策略

创建任务时确定，写进任务记录；同一项目的答案可在插件配置里存为默认值。

```jsonc
"delivery": {
  "deploy":       { "target": "docker", "mode": "auto" },   // target: docker|host|none；mode: auto|on-request
  "verification": "agent-then-human",                       // agent | agent-then-human | human
  "merge":        { "mode": "auto", "target": null, "deleteBranch": true },  // mode: auto|ask|never
  "conflicts":    "ask",                                    // agent-auto | ask | stop
  "strays":       "archive"                                 // archive | keep | discard
}
```

字段语义速查：

- **deploy.target** — 验收载体：`docker`（隔离容器，推荐）；`host`（本机进程，
  **默认禁止 auto**，清单显式 `autoAllowed: true` 才豁免）；`none`（不部署，
  闸门关闭，一切如旧）。~~dsh-acceptance~~ 已移除——DSH 插件验收也是 docker
  承载的网页实例，见设计文档 §3.2 修订。
- **verification** — `agent-then-human`（默认）：agent 冒烟验接线，你验产品；
  `agent`：全自动，适合纯接口任务；`human`：必须人工验收。
- **merge.mode** — `auto`：闸门全绿自动并回源分支（可指定 `target`，默认各源
  仓库当前检出分支）；`ask`：等确认；`never`。合并只落本地，**永不 push**。
- **conflicts** — `ask`（默认）：冲突停下等人；`agent-auto`：agent 自动解决
  conflictedFiles、提交合并、重试 done（提权公开请求，不在场即停）；`stop`。
- **strays** — 未进 git 的生成物收尾方式：`archive`（自动归档到
  `archived-docs\<项目>\<任务>-<时间戳>` 并清理产物）、`keep`（默认，列出让
  你挑）、`discard`（仅放弃任务路径允许）。含链接（符号链接/交接点）的内容在
  本机不能创建链接时不归档——留在原地并在 warning 里点名，移走那几个条目即可继续。

项目默认存插件配置 **`deliveryDefaultsJson`**（Plugins 页，JSON 文本）：

```json
{ "my-project": { "deploy": { "target": "docker", "mode": "auto" }, "verification": "agent-then-human", "merge": { "mode": "auto", "deleteBranch": true } } }
```

创建时未显式指定策略的字段按此默认解析；解析顺序 = 本次请求 > 项目默认 > 内置默认
（内置默认一切关闭：target none、merge ask——不给任何存量任务添加闸门）。

## 4. 部署清单（deploy.yaml）

任务空间的 `deploy/` 目录放 `deploy.yaml`，声明支持的目标和命令。**创建任务空间时，源码根自己的
`deploy/` 目录会被整个复制过来**（源码根没有就跳过）——所以把清单**和它调用的脚本**一起放进源码根的
`deploy/`，之后每个新建的任务空间就直接可用；只放清单是不够的，命令是相对该目录执行的。**没有清单
时视作仅 docker**（`deploy.sh up/smoke/destroy`，即 L0 形态，完全兼容）。

创建时还可以**点名一个脚本**：`deployScript` 是相对源码根的文件路径（如 `deploy/notify.sh`），它会被
复制成任务空间里**固定名字**的 `deploy/deploy.sh`，于是清单不用改，每个任务背后的脚本可以不一样；
它在整份 `deploy/` 复制之后落地，所以会覆盖源码根原本的 `deploy.sh`。路径跑到源码根之外、或者不是一个
存在的文件，按 `E4014` 拒绝——**创建之前就拒绝**，不会留下半个任务空间。

```yaml
targets:
  docker:
    up: ./deploy.sh up
    smoke: ./deploy.sh smoke
    status: ./deploy.sh status --json
    destroy: ./deploy.sh destroy
  host:
    up: make run
    smoke: make check
    destroy: make stop
    autoAllowed: true        # host 默认禁 auto，显式豁免
```

语法范围（受控解析，超出即按坏清单拒绝——**绝不半解读**）：顶层 `targets:`，
二级目标名，三级标量字段。注释与空行可用；锚点/多行块等特性不支持。

- 面板的「部署验收 / 执行冒烟 / 销毁环境」执行的是清单里**策略所选目标**的命令，
  环境 id 经 `DSH_ENV_ID` 环境变量传入；
- 策略选了清单没声明的目标 → 报错（E5009），绝不静默换目标；
- 清单文件无法解析 → 报错（E5010），绝不半解读；
- 清单命令**自己负责把状态写进** `deploy/.state.json`（单行 JSON：
  `url`/`lastSmoke`/`humanAck`/`services`——冒烟结果和人工确认属于任务空间，
  销毁不清除）。

### DSH 插件的 docker 验收配方（示例）

DSH 插件的验收实例本身就是 docker 可承载的：一个装好指定版本 DSH 与插件
tarball 的镜像，启动 `dsh web --port`。清单示意：

```yaml
targets:
  docker:
    up: docker build -t dsh-plugin-accept --build-arg DSH_VERSION=0.2.0-rc.2 .. && docker run -d --name dsh-accept -p 8080 dsh-plugin-accept
    smoke: curl -fsS http://localhost:8080/ >/dev/null
    destroy: docker rm -f dsh-accept
```

（配方可以产品化为官方验收镜像模板；版本是参数——日常验收对最新 DSH 版本，
发版矩阵不进任务流水线。）

## 5. 状态文件契约

`<deploy 根>/.state.json`（或环境变量 `DSH_STATE_FILE` 指定）。**所有权**：
部署脚本写/改（up、smoke、destroy），面板只追加 `humanAck`（经确认验收端点），
插件收尾销毁只改写 URL/销毁时间戳。字段：

```jsonc
{
  "envId": "dsh-workspace-test-docker-demo",
  "url": "http://localhost:22809",     // 验收地址；销毁后置 null
  "deployedAt": "…", "updatedAt": "…",
  "lastSmoke": { "at": "…", "result": "pass" },   // 闸门读这里
  "humanAck": { "at": "…", "by": "user" },        // 面板「确认验收」写入
  "destroyedAt": "…",                  // 环境销毁时间（可选）
  "services": [{ "name": "…", "state": "running", "health": "healthy" }]
}
```

格式为**单行 JSON**（所有写方统一），逐行/字符串解析均不可靠——改动读取方时
用 JSON 解析器。

## 6. 错误码速查

| 码 | 含义 | 出路 |
|---|---|---|
| E5005 | 策略要求部署但状态文件不存在 | 部署 + 冒烟 |
| E5006 | 冒烟未通过或未跑 | 重新冒烟 |
| E5007 | 冒烟通过但缺人工确认（或两者都缺） | 面板确认验收，或结束任务二次确认点继续 |
| E5008 | 无 deploy.sh / 脚本启动或执行失败 | 看报错输出尾部；或补部署资产 |
| E5009 | 策略目标清单未声明 / target none 不可部署 | 对齐清单与策略 |
| E5010 | 清单文件无法解析 | 修 deploy.yaml（受控语法见 §4） |
| E5011 | 某个 worktree 被别的进程占用，删不掉 | 关掉从任务空间起的服务/浏览器/编辑器，再结束一次；**什么都还没动** |
| E4010 | 策略值非法 | 改策略字段 |

## 7. 典型场景

**正常交付**：创建（策略）→ agent 开发 → 部署 → 冒烟 → 面板确认验收 →
结束任务 → 合并 + 删分支 + 清环境 + 归档，一条龙。

**验收不过重来**：结束任务不做，改代码 → 部署验收（重打包）→ 执行冒烟（失败
也刷新徽章）→ 通过后再请验收。验收事实跟随任务空间：销毁不清、重建保留。

**多环境并存**：环境 id `dsh-<项目>-<任务>` 天然隔离——两个任务的容器、镜像、
端口互不相干，面板各自显示各自的卡片。

**放弃任务**：结束任务勾 force（面板）——不合并、强删分支；strays: discard
策略此时才允许全部丢弃。
