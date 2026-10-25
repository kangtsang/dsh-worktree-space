<a id="chinese"></a>

# Worktree Space

**简体中文** · [English](#english) · [更新日志](docs/CHANGELOG.md)

Worktree Space：一任务一空间，工作多路并行。把一个涉及一个或多个 Git 仓库的工作任务放进独立的任务空间目录——参与的每个仓库都在同一个任务分支上各开一个 worktree；任务空间自动注册为 DSH 工作区，会话直接在任务空间里开工；多个任务各建一个任务空间并行推进、互不干扰。建空间时可以定下**这个任务要不要部署验收**，勾了它，一条通过的冒烟记录就是收尾合并的闸门。任务结束时把任务分支合并回目标分支、移除 worktree，并把空间里遗留的文档归档到指定目录；也可以把未处理的提交和合并冲突交给一个 agent 会话处理。

两条路各有侧重，可以只看其中一条：**在面板上手动点完全程**（[使用](#-使用)），或者**让 Agent 用工具自动编排**（[高级用法](#-高级用法让-agent-全自动编排)）。完整步骤、异常流程与错误码都在 [《Worktree Space 使用指南》](USAGE.md)。

![DeepSeek Harness Plugin](https://img.shields.io/badge/DeepSeek%20Harness-Plugin-7c5cff)
![License](https://img.shields.io/badge/license-MIT-22c55e)
[![dshfind](https://dshfind.com/api/badge/kangtsang/dsh-worktree-space?lang=zh)](https://dshfind.com/zh/plugins/kangtsang/dsh-worktree-space?ref=badge)

<img src="docs/img/isolation-model.png" alt="Worktree Space隔离模型" width="960">
<img src="docs/img/user-story-flow.png" alt="Worktree Space使用流程" width="960">

📺 **视频介绍**：[Worktree Space 插件介绍（B 站）](https://www.bilibili.com/video/BV17Mn56dECu)

> [!IMPORTANT]
> **Beta（实验性）**：把提交和合并冲突交给 agent 处理的功能处于实验性验证阶段，行为可能继续调整；它**默认
> 显示**，如需隐藏这两个入口，将插件配置里的「交由 agent 解决冲突入口」设为「隐藏」（见[实验性一节](#-实验性把提交与冲突交给-agent)）；
> 本文档其余部分描述的是不借助 agent 的标准流程。遇到问题请在
> [GitHub Issues](https://github.com/kangtsang/dsh-worktree-space/issues) 里反馈。

## 📑 目录

- [🚀 安装](#-安装)
- [✨ 功能](#-功能)
- [📂 任务目录结构](#-任务目录结构)
- [🔧 环境要求](#-环境要求)
- [🔐 权限与失败边界](#-权限与失败边界)
- [🛠️ 使用](#-使用)　**面板手动流程**：[⚙️ 配置](#-配置) · [➕ 创建](#-创建-worktree-space) · [🗂️ 管理](#-管理-worktree-space) · [🚢 部署验收](#-部署验收) · [🏁 结束](#-结束-worktree-space)（[组合行为](#各选项组合的行为)）
- [🤖 高级用法：让 Agent 全自动编排](#-高级用法让-agent-全自动编排)
- [🤖 实验性：把提交与冲突交给 agent](#-实验性把提交与冲突交给-agent)
- [📝 操作日志](#-操作日志)
- [📄 配套文档](#-配套文档)

## 🚀 安装

**网页端，从命令行安装：**

```sh
dsh plugin --profile web add dsh-worktree-space
```

卸载：`dsh plugin --profile web remove dsh-worktree-space`；更新时先卸载再重新安装。

**桌面端在插件管理页里操作**：侧边栏 → **插件**，在「插件包名」填 `dsh-worktree-space`，点「安装」；
卸载时在插件列表里点开 **Worktree Space**，进「插件详情」页，右上方点「卸载」按钮。

## ✨ 功能

- **从会话里建任务空间。** 勾选要参与的仓库（默认全选）、给任务起名、定分支前缀、指定任务空间放哪。
  每个参与的仓库都会得到一份位于 `<分支前缀><任务名>` 的 worktree（前缀默认 `task/`），起点可以是各仓库
  当前的 HEAD，也可以指定某个在所有选中仓库里都存在的分支或提交。
- **唯一一项交付选择：这个任务要不要部署验收。** 任务信息最后就是一个勾选框 —— **部署到 Docker**，
  勾上后会多出一个 **部署脚本** 输入框（留空则用 `工作区/.worktree-space/deploy/deploy.sh`）。
  它之所以在建的时候就问，是因为**交付策略只在创建时落一次，事后没有入口能加、能改**：没勾等于定了
  「这个任务不做验收」，之后也不会有任何东西再提起这件事。反过来，勾了却找不到可用的入口脚本时
  **创建会被直接拒绝**，而不是留一个永远部署不起来的任务空间。
  其余收尾时的决定 —— 合到哪条分支、要不要删分支、冲突怎么办、遗留文档怎么处理 —— 都不在这里预定，
  留给结束任务那一刻当场决定。
- **部署验收**（勾了才有）。任务空间自带一个部署根：源码根的 `.worktree-space/deploy/` 会被复制进来，
  入口脚本提供 `up`（起环境、写验收地址）与 `smoke`（跑冒烟、把结果写进 `.state.json`）。
  每个任务的环境身份互不相同，任务之间不会互相顶掉。**合并之前有一道闸门**：`<部署根>/.state.json`
  里没有一条 `result: "pass"` 的 `lastSmoke`，合并就被拒；面板会问「冒烟还没过，仍要结束吗？」，
  这份豁免只有人能给。
- **注册成工作区**，名字是 `<上级>/<任务名>`，同时开一个会话，工作目录就是这个任务空间 —— 在任务空间里
  改代码，不会动到源码检出。
- **管理页面**，分三个视图（入口见「管理 Worktree Space」一节）：
  - **工作区视图**：哪些工作区可以建任务空间，以及每个工作区里有几个仓库；
  - **Git 仓库视图**：扫到的每个 Git 仓库，以及它链接的 worktree；
  - **任务空间视图**：把每个任务下面的仓库列在一起（分支、改动数、是否被锁定、是否可清理），
    任务行下面就是它的部署卡片。

  三个视图都能搜索，也能用「待处理」筛出需关注的行（有改动、被锁定、可清理，或状态读取失败）；
  每行左边的箭头能单独折叠，筛选旁的按钮可以一次全部展开或折叠。
- **给任务补仓库**：任务进行到一半才发现少一个仓库时，在任务行上点「添加仓库」—— 候选就是 Git 仓库视图里
  那一列，任务已经有的不会重复列出；也可以直接填一个仓库目录，它会注册成工作区，因此同样进入 Git 仓库视图。
  新仓库在任务现有分支上开 worktree，起点默认各仓库当前的 HEAD，也可指定分支或提交。新加的仓库可以和原来的
  仓库不在同一个公共目录、甚至不在同一个磁盘上：合并与收尾都不受影响（合并是逐仓库读它自己的源仓库做的），
  受影响的只是交接给 agent 提交时会话的工作目录盖不住那些源仓库的 `.git`，需要在那个会话里批准提权。
  本版本**不支持**从任务里移除仓库。
- **结束任务**：在任务行上点「结束任务」，默认把各仓库的分支合并回它的目标分支、删掉 worktree、把任务
  空间里的文档归档到选定的目录，最后注销这个工作区；**任务空间里还有会话在干活时先拒绝**。合并往哪儿做、
  冲突怎么办，见「结束 Worktree Space」。
- **新建任务空间**与**结束任务空间**也在工作区列表自己的 `⋯` 菜单里 —— 前者只对包含代码仓库的工作区显示，
  后者只对确属任务空间的目录显示，点开的就是同一个对话框。
- **界面完整支持中英双语。** 管理页面、创建与结束对话框、配置项及其说明、按钮与错误提示，全部随 DSH 的语言
  设置切换；插件向宿主注册 `zh` 与 `en` 两套文案（当前各 351 条），不自带语言开关。插件列表里的名称、描述与图标
  只有英文一份。
- **面板功能本身无额外服务依赖。** 入口开关、扫描深度和目录上限均由插件自身配置控制（见[配置](#-配置)）。支持 DSH
  主题。勾了「部署到 Docker」的任务另有一层前提：这台机器上要有可用的容器引擎，见
  [部署验收](#-部署验收)。
- **可开关的操作日志。** 容器根下的 `worktree-space-log.jsonl` 记录这个任务空间做过什么，默认开启，
  排查和复现直接读它；见[操作日志](#-操作日志)。

## 📂 任务目录结构

> 术语：**Worktree Space 容器**（下称**容器**）＝插件存放任务空间的专用目录，也就是**容器根目录**
> `worktree-space/`。下文每段第一次提到容器时写全称，同段之后用简称。
>
> **容器根**是**容器根目录**的简称，指同一个目录：既指那个目录本身（区域），也指设置项里要填的路径（路径）。

```text
~/workspace/                           根工作空间：项目都挂在这一层，也存放 Worktree Space 容器根目录
├── repo-x/                            项目 x 的主工作区（本身就是仓库）
├── project1/                          项目 1 的主工作区（下面若干仓库）
│   ├── repo-a/
│   └── repo-b/
├── deep-path/project2/                项目 2 的主工作区，目录位置埋得更深
│   ├── repo-c/
│   └── repo-d/
└── worktree-space/                    容器根目录：插件专用区
    ├── repo-x/                        项目层，名字就是源工作区目录名
    │   └── task-x/                    任务空间 —— 同时是会话的工作目录
    │       ├── .worktree-space/       插件专属目录：插件自己的东西全在这里
    │       │   ├── worktree-space.json  任务的记录：分支、起点、项目、仓库、部署策略与创建时间
    │       │   ├── worktree-space.md    由上面的记录渲染出来，给人读的分支、起点与约定
    │       │   └── deploy/              部署根：源码根 .worktree-space/deploy/ 的副本，.state.json 在这里
    │       └── repo-x/                位于 <分支前缀>task-x 的 worktree
    ├── project1/
    │   ├── hotfix/
    │   │   ├── repo-a/                都以 <分支前缀>hotfix 开 worktree
    │   │   └── repo-b/
    │   └── task-a/
    │       ├── repo-a/
    │       └── repo-b/
    ├── project2/                      目录位置埋得深不影响它落在同一个容器里
    │   └── task-b/
    │       ├── repo-c/
    │       └── repo-d/
    ├── archived-docs/                 归档根（默认）：非 Git 产物收在这里
    │   └── project1/                  按项目归档
    │       └── hotfix-20260926-020933/   「任务名-YYYYMMDD-HHMMSS」，每个任务一层
    ├── README.md                      第一次使用时由插件写入：这里是 Worktree 专用区
    └── worktree-space-log.jsonl   操作日志：插件发的每条 git 命令、每个错误与警告

~/my-archive/                          归档根：可以在插件设置改成指定的目录
└── project2/                          结构一样：项目一层，任务名加时间戳一层
    └── task-b-20260926-020933/
```

**Worktree Space 容器根**推荐落在**根工作空间的下一层**（`~/workspace/worktree-space`），放在哪儿只看路径上盘根下面的
第一个目录：所以 `~/workspace/project1` 和 `~/workspace/deep-path/project2` 推荐的是**同一个**
容器，项目各自埋多深都不影响。创建时仍可指定其它路径，但容器根与源码根必须互不包裹。

项目名就是**源工作区目录名**，插件自动分层，无需填写：同一个 Worktree Space 容器里跑多个项目时，各项目下同名的任务
（都叫 `hotfix`）因此各占一层，不会挤在一起。源工作区**本身就是仓库**时（工作区目录 = `~/workspace/repo-x`），
项目层与仓库层同名，得到 `repo-x/task-x/repo-x` —— 这处重复是有意接受的：布局深度恒定为三层，插件与
客户端都不需要额外信息就知道哪一层是哪一层。

**Worktree Space 容器根**是插件的专用区：第一次在这底下建任务空间时，插件会写一份 `README.md` 说明这里是 Worktree 专用区、
不要直接 `git init` 或 `clone`（已经有了就不覆盖）。反过来说，容器根本身要已经是 Git 仓库（下面有 `.git`），
创建会被**拒绝**，且一个目录都不会建出来。

归档根底下再分两层：`<项目>/<任务名>-<YYYYMMDD-HHMMSS>/`。归档结构因此与 Worktree Space 容器结构同形，一个项目的归档收在自己
那一层里；默认档就在容器根下，整块只多出 `archived-docs` 这一个目录和操作日志那个文件（见[操作日志](#-操作日志)）。删掉 worktree 不会删除对应的 Git
分支；结束任务会先把分支合并回去，再删 worktree。

## 🔧 环境要求

- [Node.js](https://nodejs.org) `>=22.19.0`
- [Git](https://git-scm.com)：所有 worktree 与分支操作都由它执行，不随插件分发，需在 `PATH` 上
- DSH `>=0.2.0-rc.1 <0.3.0-0`，即 0.2.x（下界自 `0.2.0-rc.1` 起，不含 0.3.0 线的预发布）
- 客户端：**网页端与桌面端均可用**；桌面端由人工验证，命令行矩阵未覆盖

**五个官方版本逐个实测通过**：`0.2.0-rc.1`、`0.2.0-rc.2`、`0.2.1-rc.1`、`0.2.1-rc.2`、`0.2.1-rc.3`，
每个版本都用**该版本自己**的 DSH CLI 在一次性 profile 里跑通了安装、启动、卸载、回滚。这套验证覆盖的是
**命令行与网页端**的路径；桌面端（Electron）只做了人工安装可用性确认，未纳入脚本矩阵。逐条记录见
[`docs/store-evidence.md`](docs/store-evidence.md)。

DSH 会**强制校验**清单里 `peerDependencies` 声明的 DSH 版本范围：运行时的版本不满足，就在安装前或启动时
拒绝加载，并给出 `dsh plugin allow-version` 的精确豁免命令。`engines.dsh` 之类的字段只是声明，不会阻止加载。
实测范围之外的版本一律按未知处理，不拿宽泛范围冒充证据；遇到版本相关的问题请到
[Issues](https://github.com/kangtsang/dsh-worktree-space/issues) 反馈。

## 🔐 权限与失败边界

本插件在运行时会读写文件、并调用 `git`；这两类权限就是它的功能本身，无法裁剪为零。运行期依赖都由 DSH
profile 提供，不随插件分发 —— 安装本插件不会引入新的运行期第三方依赖，也不连接任何外部服务、不上报遥测。

**权限一览：**

| 权限 | 范围 |
| --- | --- |
| 文件读取 | 所选工作区目录（广度优先扫描，跳过 `node_modules`、`dist`、`build`、`vendor` 与隐藏目录，`.worktrees` 除外）；任务空间与 Worktree Space 容器根下的记录文件；各 worktree 的 `.git` 标记文件；结束任务时为判断合并是否仍留冲突而读回变更文件的内容 |
| 文件写入 | 只写任务空间与 Worktree Space 容器根下的文件，以及配置选定的归档目录（见[配置](#-配置)），结束时删除的是插件自己创建的 worktree 与文档；合并时另在**系统临时目录**里建一份临时检出，用完即删。**不写**源码仓库检出里的文件，也**不写** DSH 数据目录 |
| 命令执行 | 只调用 `git`（`git -C <目录> <子命令>`，固定参数、不经 shell，全部走同一处 `runGit`）；部署勾了时才另跑任务自己的入口脚本（`up` / `smoke`）。**`add` 与 `commit` 不在其中**：插件不代写提交，未提交的改动会让该仓库停下（见下表）；交给 agent 的提交由宿主里的那个会话自己执行 |
| 操作日志 | 容器根下的 `worktree-space-log.jsonl`，**默认开启**：改动仓库状态的 `git` 命令、任何失败的 `git` 命令、每个操作的结论、每个错误与警告（带错误码）。可在插件设置里关掉，关掉不影响已有文件。**不含任何文件内容**，URL 里的凭据写入前抹掉；不发送到任何地方，不离开这台机器 |
| 网络 | 无：插件自身不发任何 HTTP 请求，也不执行任何 `git push`；它发出的 `git` 子命令全是本地操作 |
| 凭据 | 不读取、不保存、不转发；插件不接触密钥 |
| 全局资源 | 不装全局包、不起常驻进程或服务、不写系统目录 |

逐条说明（读什么、写什么、执行哪些子命令、失败时怎么办）见 [PERMISSIONS.md](docs/PERMISSIONS.md)；
一次性 Profile 的安装、启动、卸载与回滚验收证据见 [docs/store-evidence.md](docs/store-evidence.md)。

**失败边界（绝不静默）：**

| 情形 | 行为 |
| --- | --- |
| 扫描目录数超过上限 | 不再抛错丢掉全部结果：停在上限处并提示哪些更深的仓库没看到，请提高上限或换一个更具体的工作区 |
| 任一 `git` 命令失败 | 抛出 `git <参数> failed (exit N): <stderr>`，把 Git 自己的诊断原样带出 |
| 结束任务时任务空间里还有会话在干活 | 拒绝整次收尾并点名那几个会话；先让它们停下来或结束它们 |
| 结束任务时某仓库还有未提交的改动 | 停下该仓库（`force` 才丢弃）：`uncommitted work is waiting in <worktree>; commit it before the task can be finished`；插件**不代写提交**，其余仓库继续，结果里逐条报出 |
| 合并已解决但没有提交 | `the merge in <worktree> is resolved but not committed`，现场原样保留 |
| 解决后的文件里仍有冲突标记 | `the resolved merge still has conflict markers in <files>`，原样保留，不替任何一方取舍 |
| 试合并撞上冲突 | 不自动 `merge --abort`，保留合并现场（`mergeSite` 与 `conflictedFiles`），待解决并提交后可继续 |
| 真合并撞上期间的新提交 | 试合并通过后，真合并时目标分支出现新提交，插件撤销本次合并（`merge --abort`，分支恢复原状）并原样带出 Git 的诊断；worktree 与任务分支保留，再次点「继续结束任务」会重新试合并 |
| 部署验收没通过就想合并 | 拒绝合并并说明缺什么（`up` 还是 `smoke`）；冒烟通过后直接重试即可 |
| worktree 删除失败 | 报 `failed to remove the worktree (uncommitted changes? force it deliberately)`，保留该 worktree 并报告，可用 `git worktree prune` 清理 |
| 任务目录非空 | 保留目录与工作区注册，不强行删除 |
| 无法确认的事实 | 在文档里写「未知」，不把「没有搜到」推断成「不访问」 |

## 🛠️ 使用

本节是**面板手动流程**的简述：从配置、创建、干活、部署验收到结束任务，全程在界面上点完，
不需要「队长 / 队员」或工具调用那一套。每一步的完整说明、会遇到的异常与被拒之后怎么办，
见 [《Worktree Space 使用指南》](USAGE.md)。
另一条路 —— 让一个 Agent 用 `wts_worktree_space` 把整条链自动跑完 —— 见
[高级用法：让 Agent 全自动编排](#-高级用法让-agent-全自动编排)。

### ⚙️ 配置

**在界面里改**（推荐）：侧边栏 →「插件」→ **Worktree Space** →「插件详情」页的配置区，和其它插件的配置在同一处，
保存后立即生效，无需重启。也可以直接改配置文件：DSH 数据目录下 `profiles/<profile>/cordis.patch.yml`
里这个插件的 `config:` 区块，改完重启 DSH 生效。

| 设置 | 取值 | 默认 | 说明 |
| --- | --- | --- | --- |
| 面板入口（「新会话」下方） | 显示 / 隐藏 | **隐藏** | 侧边栏面板列表里那一行，整页打开管理页面（页面自带左侧导航和「返回会话」）；默认隐藏 |
| 侧边栏底部快捷入口 | 显示 / 隐藏 | 显示 | 侧边栏底部那个快捷入口，以**对话框**打开同一个管理页面 |
| 交由 agent 解决冲突入口 | 显示 / 隐藏 | 显示 | 结束任务对话框里「交由 agent 提交」「交由 agent 解决冲突」两个**实验性**入口；隐藏时走标准流程：自己提交、自己解决冲突，再点继续结束任务 |
| 交由 agent 处理冲突和提交的会话使用完全权限 | 关 / 开 | **关** | 打开后，这两个会话开在**任务空间**上并立即置为「完全权限」（`danger-full-access`）；**代价是该会话此后可以写到这台机器上 DSH 进程能写的任何位置**，不再逐次询问。只影响之后开起的会话，结束任务对话框里可以就地切换。 |
| 操作日志 | 开 / 关 | **开** | 容器根下 `worktree-space-log.jsonl` 的开关。关掉只是不再写新记录，磁盘上已有的日志原样保留 |
| 扫描深度 | 1–5 层 | 3 层 | 从工作区目录（第 0 层）往下找 Git 仓库的层级数 |
| 最大遍历目录数 | 500 / 1000 / 2000 / 3000 / 5000 / 10000 | 2000 | 一次扫描最多读取的目录数；超了会停下来并提示哪些没看到 |
| 工作区仓库扫描忽略目录 | 任意目录名列表 | 内置 25 个 | 扫描永远不会进入这些名字的目录。插件自带 25 个：各语言的依赖与编译输出目录（`node_modules`、`target`、`__pycache__`、`Pods` 等），加上插件自己的任务容器名 `worktree-space`、`dsh-worktree-space`。可以添加自己的，也可以把内置的放回来 —— **放回内置项需要二次确认**，因为代价落在下一次扫描上。名字不区分大小写；点右侧「编辑」打开对话框，可搜索、增删，保存后才写入配置 |
| 默认分支前缀 | 任意文本 | `task/` | 新建任务空间时默认用的前缀；在新建对话框里改动并勾选「设为默认分支前缀」，点创建时一并写回这里 |
| Worktree Space 容器根目录 | 默认 / 指定目录 | **默认** | 新建任务空间默认放哪。**推荐用默认**：它按下面的规则从源码根推导，落在根工作空间的下一层，因此同一根工作区下的所有项目——无论各自埋得多深——都会落进同一个容器。若改用指定目录，而它与仓库目录没有公共祖先，agent 处理提交与冲突的会话需要手动提权 |
| 指定 Worktree Space 容器根目录 | 任意路径 | 留空 | 只在「指定目录」这一档生效；留空则按推荐规则推导。新建对话框里改动容器根并勾选「设为默认 Worktree Space 容器根目录」，点创建时把这两项一并写回 |
| 归档文档位置 | 跟随容器根 / 指定目录 | **跟随容器根** | 遗留文档存到哪个根目录下；两档都在该根目录下再建一层 `<项目>/<任务名>-<YYYYMMDD-HHMMSS>`，时间戳是归档那一刻的本地时间，精确到秒。默认档收在容器根自己的 `archived-docs` 里，与任务空间建在哪一层无关 |
| 指定归档目录 | 任意路径 | 留空 | 只在「指定目录」这一档生效；留空则收在容器根的 `archived-docs` 里 |

扫描覆盖全部工作区；按广度优先逐层进行，每层最多同时读 8 个目录。任何一层只要发现 `.git` **目录**就认定是
仓库（`git` 的链接 worktree 里 `.git` 是文件，不重复计入）；`node_modules`、`dist`、`build`、`vendor` 等目录
和隐藏目录会跳过（`.worktrees` 除外）。

### ➕ 创建 Worktree Space

<img src="docs/img/new-worktree-space.png" alt="新建 Worktree Space 对话框" width="720">

> 术语：**源码根**＝交给插件的工作区目录：它自己是一个 Git 仓库，或者它作为顶层目录装着若干 Git 仓库。

四个入口都能到这里：会话输入框旁的插件图标、管理页面里工作区或仓库行的 **新建 Worktree Space**、
工作区列表里的 `⋯` 菜单。对话框从上到下：

1. **选择仓库**：勾选任务要参与的仓库，卡片上标着各仓库当前 HEAD 所在的分支与路径，底部有
   **全选 / 清空** 和「已选择 N / M 个仓库」。**至少要选一个**。
2. **任务名称**：会转成小写，除字母、数字、点、连字符和下划线以外的字符（空格、中文等）都换成连字符；
   它同时是任务空间的目录名和分支后缀。不合法时直接说出违反了哪一条。
3. **分支前缀**：分支名就是前缀加任务名（默认 `task/`）。改成与当前默认不同的值时，下面出现
   **设为默认分支前缀** —— 勾选后，点「创建并打开会话」时把这次的值写回插件设置。
4. **Worktree Space 容器根目录**：界面已填好推荐值（**根工作空间的下一层** `worktree-space`），通常无需修改；
   改动时同样出现 **设为默认…**，勾选后把这次的路径写回设置。容器根自身是 Git 仓库会被拒绝。
5. **部署到 Docker**（默认不勾）：勾上后多出 **部署脚本** 输入框，留空则用
   `工作区/.worktree-space/deploy/deploy.sh`。这一格定的是「合并要不要冒烟这道闸门」，
   **只在创建时这一回落一次**，之后没有入口能补。
6. **分支起点**：**各仓库当前 HEAD**（默认）或 **指定分支或提交**；指定时那个 ref 必须在**每一个**
   选中的仓库里都存在，缺一个就被拒。
7. **预览**：跟着上面的输入实时算出这次的**分支名**与**空间目录名**。
8. 点 **创建并打开会话**：建完直接在该任务空间开一个会话。

如果任务空间已经建好、但工作区注册失败，对话框说明原因，并提供重新注册的入口；注册之后它就是一个正常的
任务空间，可以按「结束任务」正常收掉。注册之外的步骤失败时，建出来的那部分会被**回滚**掉 —— 目录、
worktree 与分支一起，不会留半个任务在那儿。

### 🗂️ 管理 Worktree Space

<img src="docs/img/manage-worktree-space.png" alt="管理页面：工作区 / Git 仓库 / 任务空间三个视图" width="960">

打开 **管理页面**，两种形态：

- **侧边栏底部的 Worktree Space**（默认显示）—— 以**对话框**打开；
- **侧边栏「新会话」下方的 Worktree Space 行**（默认隐藏，在**配置**里打开）—— 在主区域**整页**打开，
  导航第一项是 **返回会话**。

两种形态共用同一条左侧导航，下面三项在**工作区 / Git 仓库 / 任务空间**三个视图间切换；导航底部是
**⚙ 插件设置**，跳到宿主的插件页改本插件的配置。右侧的统计跟着视图变（`N 个任务` / `N 个工作区` /
`N 个仓库 · M 个 Worktree`），搜索或筛选时显示 `可见 / 总数`。

面板每次打开都会重新扫描，但会先用宿主缓存的上一次扫描结果绘制界面，打开即可显示数据。这份记忆只放在
DSH 实例的内存里，实例关闭时随之清空。

### 🚢 部署验收

勾了「部署到 Docker」的任务，任务空间里会多一张**部署卡片**（管理页面的任务行下面），提供两件事：

- **`up`** —— 跑入口脚本把环境起来，并把**验收地址**写进 `<部署根>/.state.json`；
- **`smoke`** —— 跑冒烟，由脚本自己把 `lastSmoke: { result, at }` 合进同一个状态文件。

环境身份由容器根、项目、任务名与本地端口一起算出，**每个任务一份，互不干扰**；动态端口每次部署都可能变，
所以状态（地址、最后一次冒烟）都是每次读了实时拿的，而不是某次读到的缓存。结束任务时若有这套环境，
会把它拆掉 —— 随它一起消失的是那个 URL（动态端口已经没了），而冒烟的通过与否会留在记录里。

合并之前还有一道闸门：`<部署根>/.state.json` 里没有一条 `result: "pass"` 的 `lastSmoke`，合并就被拒，
对话框直接说出缺的是部署还是冒烟。**这份豁免只有面板上的你能给** —— 你可以在对话框里确认「冒烟没过仍要结束」，
任务记录里会留下一条 `delivery-gate-bypassed` 警告；走工具调用那条路时，越过闸门的唯一办法是把环境起来、
把冒烟跑过。

> 部署根的复制规则、状态文件契约、环境身份怎么算，见
> [使用指南第 6 节](USAGE.md#6-部署验收)。

### 🏁 结束 Worktree Space

<img src="docs/img/finish-task.png" alt="结束任务对话框" width="720">

在任务行上点 **结束任务**，或在工作区列表的 `⋯` 菜单里点 **结束任务空间**。对话框打开时先把**计划**读一遍
（不信任打开它的那一行），逐个仓库列出：当前分支、**要合并到哪条分支**（可以换）、领先几个提交、
有几个文件没提交，以及确实存在遗留内容时才出现的 **归档任务空间里的文档** 选项。

四个勾选框：**合并回目标分支**（默认选中）、**删除分支**、**强制**、**归档任务空间里的文档**（默认选中）；
「删除分支」在不合并也没勾强制时不可用。

**「确认结束任务」按不下去，只有三种原因**，对话框会当场点名：任务空间里还有会话在干活、还有仓库带着未提交的
改动（而「强制」没勾）、或者部署验收还差一次通过的冒烟。

结束任务是一条标准流程，分三步：

**1. 提交。未提交的改动必须由你提交，插件不代为提交。** 只要还有仓库带着未提交改动、而「强制」没勾，
按钮就一直不可用 —— 这些改动不是插件这一侧能写的，worktree 也不会带着它们被移除。在各自的 worktree 里
`git add` 与 `git commit`（提交信息由你写），**关掉再打开对话框**（它会重读），那些仓库就不再拦着了。
也可勾选 **强制**：放弃这些改动，它们随 worktree 一并丢弃。需要代为处理时用 **交由 agent 提交**
（实验性，见[下一节](#-实验性把提交与冲突交给-agent)）。正处在未完成合并中的仓库不走这一步，那份交给第 3 步。

**2. 合并。先反着试一次，再正着合。** 真正的合并是**把任务分支合并进目标分支**（默认是该仓库源检出
所在的分支），落点在**源仓库**。但在动目标分支之前，插件先在任务空间**自己的 worktree 里反着试一次**
（把目标分支合进任务分支）：

- **干净** —— 撤销这次试合并，再按常规把任务分支 `--no-ff` 合并进目标分支，历史顺序不变；
- **冲突** —— **不中止、不还原**，这次试合并停在任务分支的 worktree 里，带着冲突标记，
  **目标分支未被触碰**，源检出也不变。

反过来试的理由就在上面：真合并一旦冲突，现场就落在源码检出上、要逐处取舍；先反着试，冲突就落在插件自己的
worktree 里，可以就地处理。

**3. 冲突。停下，等你在现场解决。** 只要有仓库停在冲突上，这次结束就是**部分完成**：其余仓库照常合并并移除，
停在冲突上的仓库原地保留，报告里给出 `mergeInProgress`、`mergeSite`（现场目录）与 `conflictedFiles`。
现场就是任务分支自己的 worktree：在那里解决冲突、`git add`，再用一条说明取舍的 `git commit` 完成合并提交，
然后点 **继续结束任务**。需要由 agent 处理时用 **交由 agent 解决冲突**（实验性）。没提交干净、或者文件里还留着
冲突标记的，插件**不替它提交**，原样保留并说明。

#### 各选项组合的行为

| 合并回目标分支 | 删除分支 | 强制 | 会发生什么 |
| --- | --- | --- | --- |
| ✓ | | | 「确认结束任务」先不可用：把每个 worktree 里的未提交改动提交到各自的任务分支，再把任务分支以 `--no-ff` 合并进它那一行选定的目标分支；移除 worktree；**分支保留**。停在冲突上的仓库原地保留、其余照常结束 |
| ✓ | ✓ | | 同上，并在合并成功后删除分支（`git branch -d`，所以未合并的分支删不掉） |
| ✓ | | ✓ | 合并照做，**跳过提交那一步**：worktree 里未提交的改动**随 worktree 一起丢弃**；分支保留 |
| ✓ | ✓ | ✓ | 合并、强制删除分支（`git branch -D`）；分支已合并，所以并不额外丢东西 |
| | | | 什么都不合并：改动仍要自己提交（提交留在保留下来的分支上），再移除 worktree 和任务空间，**分支保留**（随时可以自己合） |
| | | ✓ | 同上但不提交：未提交的改动**随 worktree 一起丢弃**；分支保留 |
| | ✓ | ✓ | **放弃**：不合并、不提交，强删分支，**分支上未合并的提交连同 worktree 里未提交的改动一并丢弃** |

（不合并又没勾强制的组合下，「删除分支」不可用，所以表里没有那一行。）勾了 **强制** 的组合都会跳过提交那一步。

无论哪种组合，有三条不变：

1. **插件自己的元数据总是被清除。** `.worktree-space/` 下的任务记录（JSON 与由它渲染出的 Markdown）
   和里面的部署根副本，每次结束都清掉。
2. **遗留内容按「归档任务空间里的文档」的选择处理。** 只有确实存在非构建产物时才出现这个勾选框：勾着就复制进
   归档目录 `<归档根>/<项目>/<任务名>-<时间戳>/`；**取消勾选就是删除**，取消时对话框会当场点名会被删的东西。
   构建产物与编辑器状态总是清掉 —— 它们放在工作目录里是常态，不是要留下来的东西。
3. **没做完的仓库原样保留。** 改动没人提交、或者合并停在冲突上的仓库会原样保留并记为未完成（其余仓库照常结束），
   任务空间目录和它的工作区注册也因此都留下；只有所有仓库都真的移除了，任务空间目录与工作区注册才一起删除，
   其中的会话落到「未分组」但对话记录保留。

「结束任务」按钮的颜色跟着这件事走：**橙色**是常规收尾（合并可以回退，没有东西被丢）；只有对话框能
明确列出「哪些内容将被丢弃」时才是**红色**——也就是选择放弃任务空间（不合并、强制删分支），而 worktree
里还有未提交的文件、或者分支上还有未合并的提交。

> 这份组合表只是速查。每个勾选框的确切含义、被拒之后的处理，见
> [使用指南第 7 节](USAGE.md#7-结束任务)。

## 🤖 高级用法：让 Agent 全自动编排

面板手动操作之外，还有一条同样受支持的路：给一个 Agent 装上 `wts_worktree_space` 与
`wts_session_tool` 两个工具，它可以自己把整条链跑完 —— 建空间、派单、盯进度、插话纠偏、部署验收、收尾合并，
全程不需要人在面板上按任何按钮。

这条路上的两个角色：**队长**是编排的那一个（也是你在对话里的那一个），**队员**是它在任务空间里开出来干活
的那一个会话。定义见[使用指南第 11 节](USAGE.md#11-术语补充队长与队员)。

| 阶段 | 队长怎么走 |
| --- | --- |
| 先看一眼布局 | `suggest-root`：某个源码根下有哪些仓库、推荐容器根在哪 |
| 建空间 + 派第一件活 | `create`：建目录与 worktree、注册工作区、开一个队员会话并把任务书交给它 |
| 派第二件及以后的活 | `dispatch`：在同一个任务空间再开一个会话（**不要对着同一件活连着派两次**，两个会话改同一批文件会互相打断） |
| 中途补仓库 | `add`：给已经存在的任务加一个 worktree |
| 盯进度 | `wts_session_tool status` 的 `lastActivity` 判「卡住」还是「在跑长步骤」，不轮询 |
| 中途改需求 | `wts_session_tool send` 以 `mode: "steer"` 注入，长回合里也送得到 |
| 异常回接 | 队员会话异常中断时会自动收到通知，按通知里的会话 id 把它拉回工作 |
| 收尾合并 | `done` 带 `merge` 一次完成合并、移除 worktree、归档遗留内容；停在冲突或未提交上时，把队员会话指回来处理后再调一次 |
| 部署验收 | 勾了部署的任务，用任务空间自己的入口 `up` / `smoke` 过冒烟闸门 |

盯住一个会话靠的是 `wts_session_tool` 的八个 action：`find` / `status` / `read` / `send` / `create` /
`resume` / `cancel`。参数与「何时用哪个」见[使用指南附录](USAGE.md#附录会话控制工具参考)。

两条路执行的是**同一套流程**，差别只在由谁驱动。完整的步骤、以及**哪些事仍然只有人能做**
（放弃任务、丢弃遗留内容、豁免冒烟闸门），见使用指南的
[第二部分 · Agent 自动编排](USAGE.md#第二部分--agent-自动编排)。

## 🤖 实验性：把提交与冲突交给 agent

结束任务对话框可以开一个 DSH agent 会话代为完成两件事：**交由 agent 提交**（有未提交改动的仓库）、
**交由 agent 解决冲突**（停在合并冲突上的仓库）。两种都**不 push、不动其它仓库或任务空间、不把分支
合并回目标分支**——那一步是插件的。两个入口默认显示，可在配置里隐藏。

- **交由 agent 提交**：开一个会话，把每个 worktree 的改动 `git add` 并提交，提交信息说明改动内容与原因
  （语言和风格随该仓库已有的提交）。
- **交由 agent 解决冲突**：开一个会话，读两边的变更、弄清各自想做什么，写出同时保留双方意图的版本，
  `git add` 之后用一条说明取舍方式的提交信息 `git commit`，完成本次合并提交。

这些仓库**共用一个会话**（冲突阶段会复用提交阶段那一个 —— 它已经把这个 worktree 的改动读过一遍了）。
会话的工作目录取它们边界的共同祖先，够不到源仓库的 `.git` 时会在那个会话里请你批准提权。

默认的工作目录由布局决定，不由插件决定 —— 所以这些会话只会落进**恰好**在那个目录上的工作区，布局里没有就
散进侧边栏的「未分组」。配置里的 **交由 agent 处理冲突和提交的会话使用完全权限**（默认**关**）改变这一点：
打开后，这两个会话开在**任务空间**上并立即置为「完全权限」（`danger-full-access`），因为任务空间够不到源仓库的
`.git`。**代价是那个会话此后可以写到这台机器上 DSH 进程能写的任何位置**，不再逐次询问；这条权限记在会话日志里，
重启后依然生效。它**只影响之后开起的会话**，结束任务对话框里可以就地切换并写明当前状态。开在任务空间上还有一个
好处：工作区列表里那一条以这个任务命名，收尾删掉任务空间时一并删除，不会像挂在容器根那样留一条所有项目共用的条目。
会话开起来后还会被放进那条分组里——工作区已经存在时，新开的会话不会自己加入，所以这一步由插件显式做。

步骤很简单：点按钮 → 会话开起来干活（对话结束后插件重读一次计划，标题换成绿灯加「可以继续结束任务」）→
你自己点 **确认结束任务** 或 **继续结束任务**。**最后那一下始终由你按下**，会话停下来不会自动往下走。

> 完整步骤与会话工作目录怎么定，见[使用指南第 7.6 节](USAGE.md#76-可选把提交和冲突交给-agent实验性)。

## 📝 操作日志

容器根下有一个 `worktree-space-log.jsonl`，**默认开着**，记录这次任务空间里发生过的每一步：

- **改动仓库状态的 git 命令**，以及**任何一条失败的 git 命令**（哪怕失败的是只读命令）。
  成功的只读查询不记，否则文件会被 `git status` 的回声淹没。
- **每个操作的结论**：创建成功还是失败、结束任务收掉了哪些 worktree。
- **插件遇到的每个错误和警告**，带一个错误码，码能直接定位到源码里出问题的那一行。

**开关：** 插件设置里的 **操作日志** 可以关掉。关掉只是不再写新记录，**磁盘上已有的日志原样保留**——
那常常是某次工作唯一的一份账。想清掉就自己删文件。

它**不发送到任何地方**，就是容器根下的一个文件；容器根被删，日志一起没。
写日志失败也不会影响任何操作。

## 📄 配套文档

| 文档 | 内容 |
| --- | --- |
| [USAGE.md](USAGE.md) | **《Worktree Space 使用指南》**：分**面板手动流程**（1–9 节：管理页面、新建、工作、补仓库、部署验收、结束任务、冲突处理、排障）与**Agent 自动编排**（10–14 节）两部分，另有错误码速查与「会话控制工具」附录。英文部分见[本文档英文区](#english) |
| [PERMISSIONS.md](docs/PERMISSIONS.md) | 权限与失败边界的完整声明：读什么、写什么、执行哪些 `git` 子命令、失败时如何处理 |
| [docs/store-evidence.md](docs/store-evidence.md) | 一次性 profile 的安装、启动、卸载与回滚验收步骤与逐版本记录 |
| [CHANGELOG.md](docs/CHANGELOG.md) | 版本发布历史 |
| [GitHub Issues](https://github.com/kangtsang/dsh-worktree-space/issues) | 问题反馈 |

---

<a id="english"></a>

# Worktree Space (English)

**English** · [简体中文](#chinese) · [Changelog](docs/CHANGELOG.md)

Worktree Space: One task, one space — work on parallel tracks. A task that involves one or more Git repositories goes into its own task space directory, where each participating repository gets a worktree on one shared task branch; the task space registers itself as a DSH workspace and sessions start working inside it, so several tasks can run in parallel without interfering with one another. When the space is created you settle **whether this task deploys for acceptance** — tick it, and a passing smoke record becomes the gate the finishing merge has to clear. When a task is finished its branch is merged back into the target branch, the worktrees are removed, and whatever documents were left in the space are filed into a directory you choose; uncommitted work and merge conflicts can instead be handed to an agent session.

The two routes differ in emphasis and you can read only one of them: **clicking through the whole thing on the panel** ([Usage](#-usage)) or **letting an agent orchestrate it with the tools** ([Advanced](#-advanced-letting-an-agent-orchestrate-end-to-end)). The full step-by-step instructions, the failure paths and the error codes live in the [Worktree Space manual](USAGE.md).

![DeepSeek Harness Plugin](https://img.shields.io/badge/DeepSeek%20Harness-Plugin-7c5cff)
![License](https://img.shields.io/badge/license-MIT-22c55e)
[![dshfind](https://dshfind.com/api/badge/kangtsang/dsh-worktree-space?lang=zh)](https://dshfind.com/zh/plugins/kangtsang/dsh-worktree-space?ref=badge)

<img src="docs/img/isolation-model.png" alt="Worktree Space Isolation Model" width="960">
<img src="docs/img/user-story-flow.png" alt="Worktree Space User Story" width="960">

> [!IMPORTANT]
> **Beta (experimental)**: handing the commits and the merge conflicts to an agent is a feature
> in an experimental validation phase and is **shown by default** - set the plugin's agent handoff
> entry to hide to take those two entries off the finish dialog; its behaviour may still change
> (see the [experimental section](#-experimental-handing-the-commits-and-the-conflicts-to-an-agent)).
> The rest of this document describes the flow
> without an agent. Please report problems in
> [GitHub Issues](https://github.com/kangtsang/dsh-worktree-space/issues).

## 📑 Contents

- [🚀 Install](#-install)
- [✨ Features](#-features)
- [📂 Layout of a task](#-layout-of-a-task)
- [🔧 Requirements](#-requirements)
- [🔐 Permissions and failure boundaries](#-permissions-and-failure-boundaries)
- [🛠️ Usage](#-usage)　**the manual route**: [⚙️ Configuration](#-configuration) · [➕ Create](#-create-a-worktree-space) · [🗂️ Manage](#-manage-a-worktree-space) · [🚢 Deploy and acceptance](#-deploy-and-acceptance) · [🏁 Finish](#-finish-a-worktree-space) ([combinations](#what-each-combination-does))
- [🤖 Advanced: letting an agent orchestrate end to end](#-advanced-letting-an-agent-orchestrate-end-to-end)
- [🤖 Experimental: handing the commits and the conflicts to an agent](#-experimental-handing-the-commits-and-the-conflicts-to-an-agent)
- [📝 The operation log](#-the-operation-log)
- [📄 Companion documents](#-companion-documents)

## 🚀 Install

**On the web client, from the command line:**

```sh
dsh plugin --profile web add dsh-worktree-space
```

To uninstall: `dsh plugin --profile web remove dsh-worktree-space`. To update, remove and reinstall.

**On the desktop client, from the plugin management page:** sidebar → **Plugins**, put
`dsh-worktree-space` in **Plugin package name**, and press **Install**; to remove it, open
**Worktree Space** from the list, go to its **Plugin details** page, and press **Uninstall** at the
top right.

## ✨ Features

- **Create a task space from a session.** Tick the repositories taking part (all of them are ticked
  to start with), name the task, settle the branch prefix, and say where the space goes. Every
  participating repository gets a worktree on `<branch prefix><task>` — `task/<task>` by default —
  starting from each repository's current HEAD, or from a branch or commit that exists in **every**
  selected repository.
- **One delivery choice, and only one: does this task deploy for acceptance?** The bottom of Task
  details is a single tick box — **Deploy to Docker** — which, once ticked, adds one **Deploy script**
  field (empty means `workspace/.worktree-space/deploy/deploy.sh`). It is asked at creation because
  **the delivery choice is made once, when the space is created, and nothing afterwards can add or
  change it**: not ticking it settles "this task needs no acceptance", and nothing later will mention
  that again. Ticking it while no usable entry script exists **refuses the create outright**, rather
  than leaving a task space that can never deploy.
  Everything a finish decides — which branch to merge into, whether to delete it, what a conflict
  does, what happens to the documents left behind — is deliberately not settled here, and is asked at
  the finish, where you can see the work it applies to.
- **Deploy and acceptance** (when it was ticked). The task space carries its own deploy root: the
  source root's `.worktree-space/deploy/` is copied into it, and its entry script answers `up` (raise
  the environment, write the acceptance URL) and `smoke` (run the smoke test, write the result into
  `.state.json`). The environment identity is computed from the container root, the project, the task
  name and a local port, so **each task gets its own, and tasks cannot crowd each other out**. There
  is **a gate before the merge**: without a `lastSmoke` carrying `result: "pass"` in
  `<deploy root>/.state.json`, the merge is refused; the panel then asks whether to finish anyway,
  and that exemption is one only a person can give.
- **Registered as a Workspace** named `<parent>/<task>`, opened with a session whose working
  directory is the task space, so code can be edited inside the task space without touching the
  source checkouts.
- **A management page**, with three views (the ways in are listed under Manage a Worktree Space):
  - **Workspaces** shows which Workspaces can host a task space, and how many repositories
    each one has;
  - **Git repositories** lists every Git repository found and the worktrees linked to it;
  - **Task spaces** puts each task's repositories together (branch, how many files changed,
    whether it is locked or prunable), with that task's deployment card under its row.

  All three can be searched, and **Needs attention** narrows them to rows worth a look
  (changes, a lock, something prunable, or a status that failed to read). The arrow on a row
  folds that row on its own; the button beside the filters folds or opens them all at once.
- **Add a repository to a task** from its row, when the work turns out to need one the task
  did not start with. The candidates are the Git repository view's own list, minus the ones the
  task already has; a repository directory can also be typed in, and it is registered as a
  Workspace so it joins that view too. The new repository gets a worktree on the branch the
  task is already on, starting from its own HEAD or from a branch or commit you name.
  An added repository may share no common directory with the ones the task began with, and may
  not even be on the same volume: merging and finishing are unaffected, because each repository's
  source is read from its own worktree. What it does affect is the working directory of a session
  handed the commit — it cannot reach those source repositories' `.git`, so the elevation is
  approved in that session. This release does **not** offer removing a repository from a task.
- **Finish a task** from its row: each repository's branch is merged back into its target branch,
  the worktrees are removed, the task space's documents are filed under a selected directory,
  and the Workspace registration is removed — but **not while a session is still working in that
  space**. Where the merge runs and what a conflict means: see Finish a Worktree Space.
- **New task space** and **Finish task space** also sit in that workspace list's own `⋯` menu — the
  first for Workspaces that hold repositories, the second for directories that really are task
  spaces; both open the same dialog the rest of this document describes.
- **The interface is fully bilingual in Chinese and English.** The management page, the create and
  finish dialogs, the configuration items and their explanations, the buttons and the error messages
  all switch with DSH's language setting; the plugin registers `zh` and `en` with the host (351 strings
  each at this release) and carries no language switch of its own. The plugin list's name, description
  and icon are English only.
- **No extra service needed for the panel itself.** The entries, the scan depth and the directory limit all
  live in the plugin's own configuration (see Configuration). It follows DSH themes. A task
  ticked **Deploy to Docker** has one prerequisite of its own — a container engine this machine
  can reach; see [Deploy and acceptance](#-deploy-and-acceptance).
- **An operation log, on by default and switchable.** `worktree-space-log.jsonl` at the container root
  records what this task space did; reading it is how a report gets reproduced. See
  [The operation log](#-the-operation-log).

## 📂 Layout of a task

> Terms: the **Worktree Space container** (the **container** below) is the directory the plugin keeps
> task spaces in — that is, the **container root directory** `worktree-space/`. Each paragraph names
> it in full the first time and in short after.
>
> **Container root** is short for **container root directory** and points at that one directory: both
> the area it occupies and the path you fill into the setting.

```text
~/workspace/                            the root workspace: projects hang off this level, and the Worktree Space container root lives here too
├── repo-x/                             project x's main Workspace (a repository itself)
├── project1/                           project 1's main Workspace (several repositories)
│   ├── repo-a/
│   └── repo-b/
├── deep-path/project2/                 project 2's main Workspace, filed under a deeper directory
│   ├── repo-c/
│   └── repo-d/
└── worktree-space/                     the container root: the plugin's own zone
    ├── repo-x/                         the project layer, named after the source Workspace directory
    │   └── task-x/                     the task space — also the session's working directory
    │       ├── .worktree-space/        the plugin's own directory: everything it writes lives here
    │       │   ├── worktree-space.json   the task's record: branch, base, project, repositories, delivery choice, created
    │       │   ├── worktree-space.md     rendered from that record — branch, base and conventions
    │       │   └── deploy/               the deploy root: a copy of the source root's .worktree-space/deploy/, state file included
    │       └── repo-x/                 a worktree on <branch prefix>task-x
    ├── project1/
    │   ├── hotfix/
    │   │   ├── repo-a/                 both on a worktree named <branch prefix>hotfix
    │   │   └── repo-b/
    │   └── task-a/
    │       ├── repo-a/
    │       └── repo-b/
    ├── project2/                       filed under a deeper directory, and still the same container
    │   └── task-b/
    │       ├── repo-c/
    │       └── repo-d/
    ├── archived-docs/                  the archive root (default): non-Git output lands here
    │   └── project1/                   filed by project
    │       └── hotfix-20260926-020933/   `<task>-<YYYYMMDD-HHMMSS>`, one folder per task
    ├── README.md                       written once, on first use: this is the worktree-only area
    └── worktree-space-log.jsonl        the operation log: every git call, error and warning

~/my-archive/                           an archive root, chosen in the plugin's settings
└── project2/                           same shape: a project layer, then a task name with its timestamp
    └── task-b-20260926-020933/
```

The **Worktree Space container root** is recommended **one level below the root workspace** (`~/workspace/worktree-space`),
and where that is depends only on the first directory below the volume root: `~/workspace/project1` and
`~/workspace/deep-path/project2` are both offered the **same** container however deep their own project
sits. A different path can be given when a task space is created, but the container root and the source
root must not contain one another.

The project name is the **source Workspace's directory name**; the plugin layers by itself, so there is
nothing to fill in. Two projects in one Worktree Space container can each hold a task called `hotfix` without crowding
each other. When the Workspace directory *is* a repository (`~/workspace/repo-x`), the project and
repository layers end up with the same name — `repo-x/task-x/repo-x`. That repeat is deliberate: the
layout is three levels deep either way, so neither the plugin nor the client needs to be told which
level is which.

The **Worktree Space container root** is the plugin's zone: the first task space created under it writes a `README.md`
saying this is a worktree-only area and that `git init` / `clone` do not belong there (an existing one is
never overwritten). Conversely, if the container root is itself a Git repository — it has a `.git` —
creation is **refused**, and not a single directory is made.

The archive root splits two levels further, `<project>/<task>-<YYYYMMDD-HHMMSS>/`, so its shape mirrors the
Worktree Space container's and a project's documents stay in that project's own folder. By default it sits in the
container root, adding exactly one directory — `archived-docs` — and the operation log's one file to the
whole volume. Removing a worktree does not delete the Git branch behind it; finishing a task merges the
branch back first and removes the worktree afterwards.

## 🔧 Requirements

- [Node.js](https://nodejs.org) `>=22.19.0`
- [Git](https://git-scm.com): it runs every worktree and branch operation, is not shipped with the
  plugin, and has to be on `PATH`
- DSH `>=0.2.0-rc.1 <0.3.0-0`, the 0.2.x line (starting at `0.2.0-rc.1`, excluding the 0.3.0 line's prereleases)
- Clients: **both the web client and the desktop client work**; the desktop client was verified by
  hand, the command-line matrix does not cover it

**All five official releases were verified one by one** — `0.2.0-rc.1`, `0.2.0-rc.2`, `0.2.1-rc.1`,
`0.2.1-rc.2` and `0.2.1-rc.3` — each against **its own** DSH CLI, in a disposable profile, through
install, start, uninstall and rollback. That matrix covers the **command line and the web client**;
the desktop client (Electron) was only confirmed installable by hand and is not part of the scripted
matrix. The per-release record is in
[`docs/store-evidence.md`](docs/store-evidence.md).

DSH **enforces** the DSH range declared in the manifest's `peerDependencies`: a runtime that does not
satisfy it has the install refused before pnpm runs, or the plugin refused at startup, with the
exact-version exemption (`dsh plugin allow-version`) offered instead. Fields such as `engines.dsh` are
declarations and block nothing. Anything outside the tested range is treated as unknown rather than
passed off as evidence; if you hit a version-specific problem, open an
[issue](https://github.com/kangtsang/dsh-worktree-space/issues).

## 🔐 Permissions and failure boundaries

At runtime this plugin reads and writes files and runs `git`. Those two permissions *are* its
function; they cannot be reduced to zero. Every runtime dependency is supplied by the DSH profile and
none of them ship with the plugin — installing it brings in no new runtime third-party dependency,
contacts no external service and reports no telemetry.

**Permissions at a glance:**

| Permission | Scope |
| --- | --- |
| File reads | The selected Workspace directories (breadth-first scan, skipping `node_modules`, `dist`, `build`, `vendor` and hidden directories except `.worktrees`); the record files in the task space and at the Worktree Space container root; each worktree's `.git` marker file; and, at finish, the contents of the files git lists, read only to decide whether a merge still carries conflict markers |
| File writes | Only inside the task space, the Worktree Space container root, and the archive directory the configuration names (see Configuration); finishing a task removes only the worktrees and documents the plugin itself created, and a merge also `git worktree add`s one temporary checkout under the **system temporary directory** and deletes it right after. It does **not** write the files of a source repository's checkout and does **not** write the DSH data directory |
| Command execution | `git` only, always as `git -C <dir> <subcommand>` with fixed argv through a single `runGit` seam — no shell; plus the task's own entry script (`up` / `smoke`), and only for a task created with deployment ticked. **`add` and `commit` are not among them**: the plugin writes no commit, uncommitted work stops that repository (see below), and a commit handed to an agent is run by the host's own session |
| Operation log | `worktree-space-log.jsonl` at the container root, **on by default**: the git commands that change repository state, any git command that fails, the outcome of every operation, and every error and warning with an error code. Switchable in the plugin settings; switching it off leaves any log already there alone. **No file contents**, credentials in a URL masked before the write; nothing sends it anywhere and it leaves this machine |
| Network | None: the plugin itself makes no HTTP requests and runs no `git push`; every `git` subcommand it runs is local |
| Credentials | Reads, stores and forwards none; the plugin never touches keys |
| Global resources | No global installs, no daemon or resident service, no writes to system directories |

The full account — what it reads, what it writes, which subcommands it runs and what happens when
things fail — is in [PERMISSIONS.md](docs/PERMISSIONS.md); the disposable-Profile install, start,
uninstall and rollback acceptance evidence is in [docs/store-evidence.md](docs/store-evidence.md).

**Failure boundaries (never silent):**

| Situation | Behaviour |
| --- | --- |
| Directory scan hits its limit | It stops where it is and says which deeper repositories were not looked at; raise the limit, or point the Workspace at a narrower root. It no longer throws away every other path's findings |
| Any `git` command fails | Throws `git <args> failed (exit N): <stderr>`, surfacing Git's own diagnosis verbatim |
| A session is still working in the task space at finish | The whole finish is refused, naming those sessions; let them finish or stop them first |
| A repository still holds uncommitted work at finish | That repository stops (`force` is what discards it): `uncommitted work is waiting in <worktree>; commit it before the task can be finished`; the plugin **writes no commit**, the others carry on, and the result names each one |
| A merge is resolved but not committed | `the merge in <worktree> is resolved but not committed` — the state is kept as it stands |
| The resolved files still carry conflict markers | `the resolved merge still has conflict markers in <files>` — kept as they stand, no side is taken |
| The rehearsal merge conflicts | Does **not** auto `merge --abort`; the merge site is kept (with `mergeSite` and `conflictedFiles`) until it is resolved and committed, then carry on |
| The real merge meets a fresh commit | The rehearsal passed, then the real merge ran into a commit someone pushed in between: the merge is undone (`merge --abort`, the branch is left as it was) and Git's own words are surfaced; the worktree and the task branch are kept, and pressing **Continue finishing** rehearses again |
| Deploy and acceptance blocks the merge | Refuses the merge and names what is missing — a deployment or a smoke — and takes the merge again once there is a passing smoke |
| Worktree removal fails | Reports `failed to remove the worktree (uncommitted changes? force it deliberately)`; the worktree is kept and reported, and `git worktree prune` is the remedy |
| A task directory is not empty | The directory and the Workspace registration are kept rather than force-deleted |
| A fact cannot be confirmed | It is written as "unknown" — absence of evidence is never inferred as absence of access |

## 🛠️ Usage

This section sketches the **manual route** — configuration, creating, working, deploy and acceptance,
finishing — clicked through on the panel, with no leader or member and no tool calls in sight. The
full instructions for each step, the failures you can meet and what to do after a refusal are in the
[Worktree Space manual](USAGE.md). The other route — one agent driving the whole chain with
`wts_worktree_space` — is [Advanced: letting an agent orchestrate end to end](#-advanced-letting-an-agent-orchestrate-end-to-end).

### ⚙️ Configuration

**In the UI** (recommended): sidebar → **Plugins** → **Worktree Space** → the configuration
section of its **Plugin details** page, beside every other plugin's; changes take effect
immediately, no restart. The file can also be
edited directly: the plugin's `config:` block in `profiles/<profile>/cordis.patch.yml` under the DSH
data directory, which needs a DSH restart.

| Setting | Values | Default | Meaning |
| --- | --- | --- | --- |
| Panel entry (under New session) | show / hide | **hide** | The row in the sidebar's panel list that opens the management page full-width (the page brings its own left-hand navigation and its Back to conversation); hidden by default |
| Shortcut in the sidebar footer | show / hide | show | The shortcut at the sidebar foot, opening that same page as a **dialog** |
| Agent handoff entry (experimental) | show / hide | show | The finish dialog's two experimental entries, **Hand the commits to the agent** and **Hand the conflict to the agent**; hidden, the standard flow applies: commit and resolve the conflict yourself, then continue the finish |
| Full access for the sessions handed to the agent for conflicts and commits | off / on | **off** | On, those two sessions are opened in the **task space** and widened to `danger-full-access` straight away. **The cost is that such a session can afterwards write anywhere the DSH process can**, without asking again, and the grant survives a restart. It governs only the sessions opened after it, and the finish dialog can switch it where it matters. |
| Operation log | on / off | **on** | The switch for `worktree-space-log.jsonl` at the container root. Off stops new records only; a log already on disk is left alone |
| Scan depth | 1–5 levels | 3 levels | How many levels below a Workspace directory (level 0) the scan looks for Git repositories |
| Scan directory limit | 500 / 1000 / 2000 / 3000 / 5000 / 10000 | 2000 | How many directories one scan may read; past it, the scan stops and says what it did not reach |
| Directories the scan skips | any list of directory names | the plugin's 25 | A scan never descends into directories with these names. The plugin ships 25: dependency and build-output directories across languages — `node_modules`, `target`, `__pycache__`, `Pods` and the rest — plus this plugin's own task container, under both names it takes, `worktree-space` and `dsh-worktree-space`. You can add your own, and you can put one of those back. **Restoring a built-in one asks first**, because the cost lands on the next scan rather than in the dialog. Names are matched without regard to case; the Edit button on the right opens a dialog to search, add and remove, and nothing is written until it is saved |
| Default branch prefix | any text | `task/` | The prefix a new task space starts from; changing it in the create dialog and ticking Set as the default branch prefix writes it back here when the space is created |
| Worktree Space container root | default / custom directory | **default** | Where new task spaces go. **The default is the recommended choice**: it is derived from the source root by the rule above and lands one level below the root workspace, so every project under that root workspace falls into the same container however deep its own directory sits. A custom directory that shares no common ancestor with the repositories makes the session that hands commits and conflicts to an agent ask for authorisation by hand |
| Custom Worktree Space container root | any path | empty | Used only by the custom strategy; empty keeps the derived recommendation. Changing the Worktree Space container root in the create dialog and ticking Set as the default Worktree Space container root writes both back when the space is created |
| Archive documents location | in the container root / custom directory | **in the container root** | The root the archive is filed under; both strategies add a `<project>/<task>-<YYYYMMDD-HHMMSS>` folder beneath it, the stamp being the local time of that moment, to the second. The default files them in the Worktree Space container root's own `archived-docs`, wherever the task space was made |
| Custom archive directory | any path | empty | Used only by the custom strategy; empty files them in the Worktree Space container root's `archived-docs` |

A scan covers **every** Workspace. It goes breadth-first, reading up to eight directories at
a time per level. A directory holding a `.git` **directory** counts as a repository — a linked
worktree carries `.git` as a file, and is not counted twice — and `node_modules`, `dist`, `build`,
`vendor` and hidden directories are skipped (except `.worktrees`).

### ➕ Create a Worktree Space

<img src="docs/img/new-worktree-space.png" alt="The New Worktree Space dialog" width="720">

> Terms: the **source root** is the Workspace directory whose Git repositories the plugin recognises:
> the source root is itself a Git repository, or it is the top-level directory holding several Git
> repositories.

Four entries reach this dialog: the plugin icon beside a blank conversation's composer, **New
Worktree Space** on a row in the management page, and the `⋯` menu in the workspace list. From the
top down:

1. **Repositories**: tick the ones taking part. Each card names the branch its HEAD is on and its
   path, and the footer carries **Select all / Select none** with "N / M selected". **One is the
   minimum.**
2. **Task name**: lower-cased, with everything except letters, digits, dots, dashes and underscores
   (spaces, Chinese characters and so on) turned into dashes. It is both the task space's directory
   name and the branch suffix, and an invalid name is reported with the rule it breaks.
3. **Branch prefix**: the branch is this prefix plus the task name, `task/` by default. Change it to
   something other than the stored default and **Set as the default branch prefix** appears — ticking
   it writes this value back into the settings when the space is created.
4. **Worktree Space container root**: pre-filled with the recommendation, one level below the root
   workspace, and rarely changed; moving it offers the same **Set as the default…** box, which writes
   the path back the same way. A container root that is itself a Git repository is refused.
5. **Deploy to Docker** (unticked to start with): ticked, it adds one **Deploy script** field, empty
   meaning `workspace/.worktree-space/deploy/deploy.sh`. This box settles whether a passing smoke
   gates the merge, and it is **recorded once, at creation** — nothing afterwards can add it.
6. **Branch base**: each repository's **current HEAD** (the default), or a **named branch or commit**,
   which has to exist in **every** selected repository — one missing refuses the create.
7. **Preview**: the branch name and the space's directory this task will use, live as you type.
8. Press **Create and open session**: the space is built and a session is opened in it.

If the space is built but registering the Workspace fails, the dialog says why and offers to retry the
registration; once registered it is an ordinary task space and can be finished normally. When any
other step fails, what was built is **rolled back** — directory, worktrees and branch together — so no
half task is left behind.

### 🗂️ Manage a Worktree Space

<img src="docs/img/manage-worktree-space.png" alt="The management page: Workspaces, Git repositories and Task spaces views" width="960">

Open the **management page** — two ways in:

- **The Worktree Space shortcut at the sidebar foot** (shown by default) — opens it as a **dialog**;
- **The Worktree Space row under New session** (hidden by default, turn it on in the
  **configuration**) — opens it **full width** in the main column, leading with **Back to conversation**.

Both forms share one left-hand navigation: three entries switch between the **Workspaces**, **Git
repositories** and **Task spaces** views, and **⚙ Plugin Settings** at the foot jumps to this
plugin's configuration on the Host's Plugins page. The statistics on the right follow the view
(`N tasks` / `N workspaces` / `N repositories · M worktrees`) and show `visible / total` while a
search or filter is applied.

The panel rescans every time it is opened, but it first paints what the Host still remembers of the
previous scan, so it shows data straight away. That memory lives in the DSH instance's own process
only, and is gone when the instance exits.

### 🚢 Deploy and acceptance

A task created with deployment ticked gains a **deployment card** in its row on the management page,
answering two calls:

- **`up`** — runs the entry script to raise the environment, and writes the **acceptance URL** into
  `<deploy root>/.state.json`;
- **`smoke`** — runs the smoke test, the script merging `lastSmoke: { result, at }` into that same
  state file.

The environment identity comes from the container root, the project, the task name and a local port,
so **each task has its own and they do not crowd each other out**; that port can change with every
deploy, which is why the state — the URL, the last smoke — is read live on every call rather than
cached. When such a task is finished, its environment is taken down: what dies with the containers is
the URL, since that dynamic port is gone, while the smoke's own verdict stays in the task's record.

Before the merge there is one gate: absent a `lastSmoke` with `result: "pass"` in
`<deploy root>/.state.json`, the merge is refused and the dialog names what is missing, a deployment
or a smoke. **That exemption is only yours to give on the panel** — you can confirm "finish anyway"
and the task's record keeps a `delivery-gate-bypassed` warning; down the tool route, the only way past
the gate is raising the environment and running the smoke.

> How the deploy root is copied, the state file's contract, and how the environment identity is
> computed: [section 6 of the manual](USAGE.md#6-deploy-and-acceptance).

### 🏁 Finish a Worktree Space

<img src="docs/img/finish-task.png" alt="The Finish task dialog" width="720">

Use **Finish task** on the task row, or **Finish task space** in the workspace list's `⋯` menu. The
dialog reads the **plan** once more when it opens — it does not trust the row that opened it — and
lists, per repository, the current branch, **which branch it would merge into** (changeable), how many
commits it is ahead, how many files are uncommitted, and, only when there really is something left
behind, the **Archive the task space's documents** option.

Four tick boxes: **Merge into the target branch** (ticked), **Delete branch**, **Force**, and
**Archive the task space's documents** (ticked). Delete branch is unavailable without either a merge
or Force.

**There are only three reasons the finish button stays disabled**, and each one is named where you
can see it: a session is still working in the task space, a repository still carries uncommitted work
and Force is not ticked, or a passing smoke is still owed.

Finishing a task space is one standard path, in three steps:

**1. The commits are the user's to make; this plugin never writes one.** While the plan shows
uncommitted changes in a repository and **Force** is not ticked, the button stays unavailable — those
changes are not this side's to write, and a worktree will not be removed carrying them. Commit them in
each worktree with `git add` and `git commit` (the message is written by the user), then **close and
reopen the dialog**, which re-reads the plan; those repositories stop blocking it. **Force** is the
other way past: those changes are discarded with the worktree. **Hand the commits to the agent** does
it for you instead (experimental, see the [next section](#-experimental-handing-the-commits-and-the-conflicts-to-an-agent)).
A repository standing in an unfinished merge does not take part in this step — that one belongs to
step 3.

**2. Merge: rehearse the other way round, then merge for real.** The merge itself puts **the task
branch into the target branch** (by default the branch the source repository has checked out), and the
merge lands in the **source repository**. Before the target is touched, the target is merged into the task
branch **inside the task space's own worktree** — the opposite direction:

- **Clean** — the rehearsal is undone and the task branch is merged into the target with `--no-ff` as
  usual, leaving the history in its own order;
- **Conflicted** — **not aborted, not reverted**: the rehearsal stays standing in the task branch's
  worktree, with its conflict markers, and the **target branch is untouched**, as is the source
  checkout.

Why it rehearses backwards: once a real merge conflicts, the site is on the source checkout and every
difference has to be reconciled there; rehearsing first puts the conflict into the plugin's own
worktree, where it can be dealt with on the spot.

**3. A conflict stops the finish and waits for you to resolve it on the spot.** A repository standing on
a conflict keeps its worktree while the others merge and go, and the report names `mergeInProgress`,
`mergeSite` (where the conflict stands) and `conflictedFiles`. The site is the task branch's own
worktree: resolve the conflict there, `git add`, and one `git commit` that says how the two sides are
reconciled concludes the merge. **Continue finishing** then carries on. **Hand the conflict to the
agent** puts a session on it instead (experimental). Left resolved but uncommitted, or still carrying
markers, the plugin does **not** commit it for you — it keeps things as they stand and says so.

#### What each combination does

| Merge into the target branch | Delete branch | Force | What happens |
| --- | --- | --- | --- |
| ✓ | | | The button is unavailable until each worktree's uncommitted changes are committed to its own task branch, and the task branch is then merged with `--no-ff` into the target branch chosen on its row; the worktrees are removed and the **branch is kept**. A repository standing on a conflict is kept as it is while the rest finish |
| ✓ | ✓ | | The same, and the branch is deleted once the merge succeeds (`git branch -d`, so an unmerged branch cannot go) |
| ✓ | | ✓ | The merge runs and **the commit step is skipped**: uncommitted changes **go with the worktree**; the branch is kept |
| ✓ | ✓ | ✓ | Merges and force-deletes the branch (`git branch -D`); it was merged, so nothing extra is lost |
| | | | Nothing merges: the changes still have to be committed yourself — they stay on the branch, which is kept — and then the worktrees and the space are removed. **The branch is kept**, and you can merge it yourself whenever you like |
| | | ✓ | The same without committing: uncommitted changes **go with the worktree**; the branch is kept |
| | ✓ | ✓ | **Abandon**: nothing merges, nothing commits, the branch is force-deleted, and **its unmerged commits go with the worktree's uncommitted changes** |

(Without a merge and without Force, Delete branch is unavailable — hence the missing row.) Any
combination carrying **Force** skips the commit step.

Three things hold whatever you pick:

1. **The plugin's own metadata is always cleared.** The task record under `.worktree-space/` (the JSON
   and the Markdown rendered from it) and the copied deploy root go with every finish.
2. **What is left behind follows the documents tick box.** It appears only when something other than
   build output is there: ticked, those documents are copied into `<archive root>/<project>/<task>-<stamp>/`;
   **unticking deletes them**, and unticking names what will go. Build output and editor state are
   always cleared — they live in a working directory by nature, not to be kept.
3. **Unfinished repositories are kept exactly as they are.** A repository whose changes nobody
   committed, or whose merge stands on a conflict, is kept and reported as unfinished while the others
   finish; the task space directory and its Workspace registration stay too. Only once every
   repository really is gone do the directory and the registration go together — and the sessions in it
   fall back to Ungrouped with their conversations intact.

The finish button's colour follows that: **amber** is an ordinary finish, where a merge can be
reverted and nothing is lost; **red** appears only when the dialog can list exactly what will be
thrown away — abandoning a space (no merge, force-deleted branch) while a worktree still holds
uncommitted files or a branch still holds unmerged commits.

> This table is the quick reference. What each tick box really means, and what to do after a refusal:
> [section 7 of the manual](USAGE.md#7-finishing-a-task).

## 🤖 Advanced: letting an agent orchestrate end to end

Beyond driving the panel by hand, a second equally supported route exists: give one agent the
`wts_worktree_space` and `wts_session_tool` tools and it can run the whole chain itself — create the
space, dispatch, watch progress, steer mid-flight, deploy and accept, merge at the finish — with no
press in the panel at any point.

Two roles on that route: the **leader** is the orchestrating one, the one you are talking to, and the
**member** is the session it opens in the task space to do the work. Both are defined in
[section 11](USAGE.md#11-more-terms-the-leader-and-the-member) of the manual.

| Stage | What the leader does |
| --- | --- |
| Read the layout first | `suggest-root`: which repositories are under a source root, and which container root it recommends |
| Create + first dispatch | `create` does it in one call: make the directory and the worktrees, register the Workspace, open a member session and hand it the brief |
| Dispatch the work after that | `dispatch` opens another session in that task space — **never dispatch the same piece of work twice**, as two sessions editing the same files interrupt each other's commits |
| Add a repository mid-task | `add` gives an existing task one more worktree |
| Watch progress | `lastActivity` from `wts_session_tool status` tells "stuck" from "busy with a long step" - no polling |
| Change the requirement | `wts_session_tool send` with `mode: "steer"`, which lands even inside one long turn |
| Recover a failure | an abnormal turn reports itself; the notice names the member session id to pull back to work |
| Finish and merge | `done` with `merge` merges, removes the worktrees and files what was left in one call; a conflict or uncommitted work is handed back to the member, then `done` again |
| Deploy and accept | for a deploying task, the space's own entry runs `up` / `smoke` to pass the smoke gate |

Keeping a hold on one session is the work of `wts_session_tool`'s eight actions: `find` / `status` /
`read` / `send` / `create` / `resume` / `cancel`. Their arguments and "which one when"
are in the [manual's appendix](USAGE.md#appendix-the-session-control-tools).

Both routes run **the same flow**; only the driver differs. The full chain, and **which steps still
have to be done by the user** (abandoning a task, discarding what was left behind, exempting the smoke
gate), are in the manual's
[part two, agent orchestration end to end](USAGE.md#part-two--an-agent-orchestrating-end-to-end).

## 🤖 Experimental: handing the commits and the conflicts to an agent

The finish dialog can open a DSH agent session to do two things: **Hand the commits to the agent**
(for repositories with uncommitted work) and **Hand the conflict to the agent** (for repositories
stopped on a merge). Neither pushes, touches other repositories or the task space, or merges the
branch into its target — that step is the plugin's. Shown by default; the configuration can hide
both entries.

- **Hand the commits to the agent** opens one session that `git add`s and commits each worktree's
  changes, the message saying what changed and why, in the language and style that repository already
  keeps;
- **Hand the conflict to the agent** opens one session that reads both sides, works out what each is
  trying to do, writes the version keeping both intentions, `git add`s it, and commits with a message
  saying how the two were reconciled.

Those repositories **share one session** — the conflict reuses the one the commits ran in, because it
has already read those changes. Its working directory is the common ancestor of their boundaries, and
where that cannot reach a source repository's `.git`, the elevation is yours to approve in that
session.

The working directory is chosen by the layout, not by the plugin, so those sessions land in whichever
Workspace happens to sit there, and fall into Ungrouped where none does. The configuration's **Full
access for the sessions handed to the agent for conflicts and commits** (off by default) changes that:
turned on, both sessions are opened in the **task space** and widened to `danger-full-access`,
because the task space cannot reach a source repository's `.git`. **The cost is that such a
session can afterwards write anywhere the DSH process can**, without asking again, and the grant is a
session-log event that survives a restart. It governs **only the sessions opened after it**, and the
finish dialog switches it where the choice is made. Opening them in the task space rather than above it
has one more benefit: the entry in the workspace list is named after this task, and the finish that
removes the task space drops that entry with it, instead of leaving a row shared by every project.
Once opened, each session is also filed under that group — a session started on a directory that is
already a Workspace does not join it by itself, so the plugin does that step explicitly.

The steps are short: press the button → the session works (once it stops, the plan is read again and
the headline turns green with "you can continue finishing") → you press **Finish task** or **Continue
finishing** yourself. **That last press is always the user's**; a session stopping never carries on by
itself.

> What each button does, how the working directory is chosen, and the full steps:
> [section 7.6 of the manual](USAGE.md#76-optional-handing-the-commits-and-the-conflicts-to-an-agent-experimental).

## 📝 The operation log

A `worktree-space-log.jsonl` sits at the container root, **on by default**, recording every step this
task space has been through:

- **git commands that change repository state**, and **any git command that fails** - including a read
  that fails. A successful read is not recorded, or the file would be nothing but the echo of `git status`.
- **The outcome of every operation**: whether a create worked, which worktrees a finish removed.
- **Every error and warning the plugin hits**, carrying an error code that points straight at the line in
  the source that went wrong.

**The switch** is in the plugin settings. Turning it off only stops new records being written - **a log
already on disk is left exactly where it is**, because it is often the only account of some piece of
work. Delete the file yourself if you want it gone.

**Nothing is sent anywhere**: it is a file in the container root, and deleting the container root takes
it with it. Failing to write it never affects any operation.

## 📄 Companion documents

| Document | What it covers |
| --- | --- |
| [USAGE.md](USAGE.md) | **The Worktree Space manual** in two independent parts — **the manual route** (sections 1–9: the management page, creating, working, adding repositories, deploy and acceptance, finishing, conflicts, troubleshooting) and **agent orchestration end to end** (sections 10–14) — plus an error-code reference and a session-control appendix. The Chinese edition is [the first half of this file](#chinese) |
| [PERMISSIONS.md](docs/PERMISSIONS.md) | The full permissions and failure boundaries: what is read, what is written, which `git` subcommands run, and what happens when one fails |
| [docs/store-evidence.md](docs/store-evidence.md) | The disposable-profile install, start, uninstall and rollback acceptance steps, with per-release records |
| [CHANGELOG.md](docs/CHANGELOG.md) | Release history |
| [GitHub Issues](https://github.com/kangtsang/dsh-worktree-space/issues) | Problem reports |
