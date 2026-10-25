<a id="chinese"></a>

# PERMISSIONS — dsh-worktree-space 权限与失败边界声明

**简体中文** · [English](#english)

本文件供 DSH STORE 自动审查与人工复核使用，如实描述插件在运行时做什么、不做什么，以及失败边界。

声明基线：`dsh-worktree-space@1.2.1`，对应本仓库默认分支上的固定提交。插件版本、`engines` 与 `dsh` 字段见 `package.json`。

## 运行时行为

- **目的**：把「一个任务横跨多个仓库」做成一份位于仓库目录之外的工作区。被选中的仓库各自用 `git worktree`
  在 `<容器根>/<项目>/<任务名>/<仓库名>` 开一份检出，全部指向同一个任务分支；这里的**项目**一层由插件
  自己按源工作区目录名分层，不用用户填；`<容器根>/<项目>/<任务名>` 这个目录再注册成 DSH
  工作区，并开一个以它为工作目录的会话。

- **读取**：
  - 工作区目录树（只读）：按广度优先 `readdir` 扫描，最多 `scanDepth` 层（1–5，默认 3）、
    最多 `maxScanDirectories` 个目录（默认 2000），每层最多并发 8 个。跳过 `node_modules`、`Library`、
    `dist`、`build`、`vendor` 以及隐藏目录（`.worktrees` 除外）。扫描只为发现「哪个目录是 Git 仓库」，
    **不读取文件内容**。
  - 任务空间里插件专属目录 `.worktree-space/` 下的两份记录 `worktree-space.json`、`worktree-space.md`，
    以及它下面部署根里的文件（脚本、清单、`.state.json`）；以及每个仓库 worktree 的
    `<worktree>/.git` 标记文件（用于判断该 worktree 是否已经失效）。
  - 容器根的 `<容器根>/.git`（存在就说明容器根本身是 Git 仓库，创建会被拒绝）与 `<容器根>/README.md`
    （存在就不再写，绝不覆盖用户自己写的内容）。两者都只做存在性判断。
  - 本插件自己包内的 `assets/skill/worktree-space/SKILL.md`（作为内置技能注册，只读，不复制到别处）。
  - 用户自己指定的路径（源码根、任务空间根——新建对话框里填的，或配置里「指定 Worktree Space 容器根目录」那一档 ——
    以及归档目录）。
  - 结束任务时，某个 worktree 里被 `git diff --name-only HEAD` 与 `git diff --name-only --diff-filter=U`
    列出（合并中还有 `ls-files -u` 一类的未解决条目）的那些文件的**内容**：逐个读回，只为判断一个合并是否
    还留着冲突标记（逐行匹配以 `<<<<<<<`、`=======`、`>>>>>>>` 开头的行）；列出来却读不出的路径（子模块、
    目录）跳过。除冲突标记外不判断文件内容，也不把内容写进日志或响应。

- **写入**：只写用户选定的**任务空间目录**、其**归档目录**、被识别为「已失效的 worktree」的那一个目录，
  以及**系统临时目录**下自建的一处合并检出（见下）；**绝不写源码仓库检出里的文件**，也不写 DSH 安装目录
  或配置文件。
  - 创建：`mkdir` 容器根、其下的项目目录与任务空间目录；在容器根首次被使用时写一份 `README.md`
    （说明这里是 Worktree 专用区；已存在则不动）；`git worktree add` 生成各仓库检出（由 git 自己落盘）；
    写 `.worktree-space/worktree-space.json` 与由它渲染出的 `.worktree-space/worktree-space.md`，
    并把源码根 `.worktree-space/deploy/` 整个复制到任务空间里的同一相对位置（源码根没有就脚手架一份状态写入脚本）。
  - 归档：把任务空间里的文档 `cp` 到配置选定的**归档根目录**下的 `<项目名>/<任务名>-<YYYYMMDD-HHMMSS>/`；
    默认的归档根就是**任务空间的容器根自己**（`<容器根>/archived-docs`，与新建任务时选的那个目录同一处），
    也可在配置里指定任意目录。
  - 清理：`git worktree remove --force` 移除检出；对 `.git` 指向的 gitdir 已不存在的**孤儿 worktree**，
    用 `fs.rm(directory, { recursive: true })` 删掉那个目录；最后，只有当任务空间目录确实空了，才删除该目录
    并注销工作区。
  - 合并：目标分支正是源仓库当前检出的那个分支时，就在源仓库原地 `git merge`（写的是它自己的分支与工作树）；
    其余情况先 `mkdtemp` 出 `os.tmpdir()/dsh-worktree-space-merge-<随机>/`，在其中 `git worktree add`
    一份目标分支的临时检出、完成合并，随后 `worktree remove --force`（失败再 `worktree prune`）
    并 `rm` 掉整个临时目录——合并已经成功时，不因为这个目录删不掉而报失败。
    **谁来触发这一步**：平时由用户自己的手（面板上勾选合并，或 agent 在你明确要求合并时传 `merge: true`）；
    而任务记录里写着 `merge.mode: auto` 时（该项目策略的**常驻授权**，建任务时记下），收尾会**不等按键**就合并。
    写着 `never` 时相反：工具传 `merge: true` 会被拒绝（`E4013`），只有面板里用户自己的手能合。
  - 试合并：带合并的结束任务会先在**任务空间里该仓库自己的 worktree** 中试合并一次；冲突就原样留在那里，
    试合并干净则 `reset --hard` 回到试合并前记录的提交，再由上面那一步在目标分支上记录合并提交。
  - git 自己的登记：`git worktree add/remove` 会写 `<源仓库>/.git/worktrees/<名字>/` 下 git 自己的登记与索引
    （`.git` 标记、`HEAD`、`index` 等）。这是 git 的行为，插件不去编辑源仓库检出里的文件。
  - 操作日志：向**容器根下的 `worktree-space-log.jsonl`** 追加一行 JSON（`fs.appendFile`），逐条说明见下。
  - 配置项（入口开关、扫描深度、默认分支前缀、Worktree Space 容器根目录、归档位置）由 DSH 自己的插件配置服务
    （Plugins 页面的实时表单）保存，**插件不写任何配置文件**；`task.preference` 端点只读。
  - 工作区登记：任务空间被创建时（面板的「创建并打开」，或 agent 工具的 `create`）通过 DSH 自己的
    workspace 服务把它**登记**成工作区；结束任务真的删掉目录时**注销**那条登记。写的是 **DSH 自己的存储**，
    不是插件去写任何文件。**界面操作没有开关**：面板建则登记、结束则注销。**工具调用是按次指定的**：
    `create` 传 `registerWorkspace: false` 就只做盘上那一半（任务空间建好但不进工作区列表），`done` 传
    `unregisterWorkspace: false` 就保留登记（会话继续归在那一组）。注销时**以列表的当前状态为准**：删失败
    会再读一次列表，登记确实还在才报告为失败，已经不在了就当作完成（那是这次注销想要的终态）。
  - 会话：工具的 `create` 带 `prompt`、或 `action: "dispatch"`，会通过**宿主的会话服务**在任务空间里新建一个
    会话，并向**该会话自己的日志**追加一条 `sandbox/mode` 策略事件（默认复制调用方会话**自己的显式覆盖**；
    调用方没有覆盖时**不写**，新会话于是落在部署默认——不会比调用方更宽），随后把这一轮任务作为提示语投给它。
    两个动作都是**调用方按次**触发的；界面上的「创建并打开」与「交由 agent」走的是另一条路。写的同样是 DSH
    自己的存储与会话日志，不是插件去写任何文件。部署没有会话服务时**不建也不报错**：工具如实回答「没有开成
     会话」，并指明去面板开。
  - 会话控制工具（`wts_session_tool`）：**读**任意会话的事件日志（在线的经宿主会话服务，离线的经会话
    持久化层，与面板读的是同一份），**发**消息给会话（`steer` 注入当前回合，`queue` 追加一轮），**开/拉回**
    会话，以及**中止**会话的当前回合。写的是 **DSH 自己的会话日志**，不是插件去写任何文件。这八个工具都是
    **调用方按次**触发的：插件不做任何自动轮询、不会自己 steer、也不会自己终止会话。部署没有相应服务时
    **不报错**：每个工具如实回答「this deployment does not offer X」，工具本身照常注册。任务空间被派活时
    记下的会话 id（`.worktree-space/worktree-space.json` 的 `sessions`）只是写进插件自己那份任务记录，与上面同一条。

- **命令执行**：通过宿主注入的 `subprocess` 服务以**固定 argv** 调用 `git`
  （`argv: ['git', '-C', <cwd>, ...args]`）：**不经过 shell**，没有字符串拼接，不接受用户提供的命令，
  不调用 `git` 以外的任何可执行文件。全部子命令见下表。

- **插件自己不提交**：`git add` 与 `git commit` **都不在本插件的命令表里**。结束任务时某个 worktree 还有
  未提交的改动，该仓库就停下并点名（见失败边界），插件不会替它写一笔提交。「把提交交给 agent」是插件
  **另开一个会话**、由**宿主里的 agent** 在那个会话中执行 `git add` / `git commit`——那些命令不是本插件
  发出的，也不属于本插件的权限信号。

- **会话权限（默认不放开）**：上面那两件交给 agent 的工作都是**另开的会话**。默认情况下，插件把这类会话的
  工作目录选在**同时够得到 worktree 与源仓库 `.git` 的公共目录**上，会话因此照常受 DSH 沙箱约束：写到该目录
  之外（例如源仓库的 git 元数据）会被沙箱拦下，交由 DSH 自己的提权审批处理，**插件既不代理也不绕过**。

  配置项**「交由 agent 处理冲突和提交的会话使用完全权限」**（`handoffFullAccess`，默认 `off`）打开后，插件对**自己刚刚为交接
  开出的**那两个会话多做两件事：
  - 工作目录取**容器根**（`<容器根>`），因此这些会话归属于插件注册的那个工作区分组，而不是未分组；
  - 会话建立之后立即向**该会话自己的日志**追加两条事件：`sandbox/mode` = `danger-full-access`，以及
    `approval/policy` = `never`。两条**一起写**是因为 DSH 自己的预设表把它们当**一档**：那一档的名字叫
    「完全权限」（英文界面 Full access），含义就是 "Full file access without approval prompts"。只写前一条的话，这一对旋钮对不上
    表里任何预设（界面会读成 `custom`），而且万一有审批请求会来问你——那不是「完全权限」这一档的意思。

  这两条事件的后果就是它们的字面意思：**那个会话此后可以写到 DSH 进程能写的任何位置**，并且**不再有审批
  请求**（真有的话按拒绝处理）。它们是会话日志里的**持久**状态，重启后按 replay 依然生效；作用域是**那个
  会话**，不是部署，也不是别的会话。

  边界：只在配置为 `on` 时发生；每次写入前**重新读一次该配置项**，关着就拒绝（`E4012`），不写任何事件；只写
  这两条事件，不碰会话的其它任何状态；只针对插件自己刚刚为交接开出的会话。**已经开出来的会话不受之后开关
  变化的影响**——要改就在那个会话里用 DSH 自己的 `/permission`。

- **网络**：插件自身**不发任何 HTTP 请求**，也**不执行任何 `git push`**。它发出的全部 `git` 子命令都是本地
  操作（见下方命令表），不写任何远端 ref。Git 自己的凭据助手与代理设置不由本插件控制。

- **凭据/密钥**：插件**不读取、不存储、不转发**任何凭据。不读 `process.env`，不读 `~/.git-credentials`、
  `~/.ssh`、`.netrc` 或 OS 钥匙串，也不把任何凭据写进日志或响应。

- **操作日志**：**容器根下的 `worktree-space-log.jsonl`**，一个只追加、不改写、不删除的 JSONL 文件。
  插件每发出一条会改动仓库状态的 `git` 命令、每有一条 `git` 命令失败、每遇到一个错误或警告，就追加一行：
  `ts`（ISO 时间）、`kind`（`git` / `error` / `warning`）、`op`（端点名）、`task`、`project`，以及各自的
  字段——命令记 `argv`、`cwd`、`exit`、`stderr`（超过 2 KB 截断），错误记 `message`、`stack`、`code` 和
  它落在哪个仓库、哪个阶段。
  - **只记路径、命令和 git 自己的报错文字，不记任何文件内容**，也不把文件内容读出来。
  - `argv` 与报错文字里 URL 的凭据在写入前替换成 `***`（`https://user:token@host/x` 记成
    `https://***@host/x`）；路径里的 `@` 不受影响。
  - 成功的**只读** `git` 命令不记（`status`、`rev-parse`、`for-each-ref` 之类）；改变状态的命令和**任何失败**
    都记，哪怕调用方会吞掉这个失败——比如探测分支是否已存在的那种查询。
  - **只在容器根已经存在时写，且从不创建目录**：容器根不存在时那次写入失败并被忽略，因此 `worktree.scan`、
    `worktree.status` 这类不属于任何任务空间的调用什么都不记。
  - 写日志的任何失败（文件被删、目录只读、磁盘满）都被吞掉，**不影响任何操作的成败**。写入是 `await` 的：
    调用返回时记录已经落盘，顺序与命令结束的顺序一致。
  - 超过 10 MB 时先把当前文件改名为 `worktree-space-log.<YYYYMMDD-HHMMSS>.jsonl` 再重开，**旧文件保留**。
  - **没有读日志的端点，日志不离开这台机器**：不外发、不上传、不进任何响应。
  - 容器根被删除，日志跟着一起没；它不是备份，也不是审计凭证。

- **外部服务**：无。不需要账号、不需要服务端、不上报遥测。

- **全局资源**：不安装全局包、不起守护进程、不注册系统服务、不改文件权限、不建符号链接；扫描结果缓存
  只存在 DSH 实例的内存里，实例退出即消失。

  最后一条有一个例外，写在这里以免和代码对不上：**探测本机能否创建符号链接时，会在临时目录下真的
  建一个再删掉**（`links.js` 的 `symlinksRefused`）。它判定的正是"这台机器愿不愿意让我建链接"——
  所以只能用真建一次来问，而 `mkdtemp(tmpdir())` 下的这个探针会被立刻递归删除。它**不改变任何
  用户文件的权限，也不碰任务空间或源码根**；语义上不与"不建符号链接"冲突（那一条说的是不为用户
  的东西建链接），字面上确实是这行代码之外的一个创建动作，因此在此点名。整个进程只探一次。

### 调用的 git 子命令全集

| 分类 | 子命令 |
| --- | --- |
| 查询（只读） | `rev-parse --show-toplevel`、`rev-parse --git-common-dir`、`rev-parse --abbrev-ref HEAD`、`rev-parse HEAD`、`rev-parse --verify --quiet <ref>^{commit}`、`rev-parse --verify --quiet MERGE_HEAD`、`symbolic-ref --quiet --short refs/remotes/origin/HEAD`、`for-each-ref --format=%(refname:short) <refs>`、`show-ref --verify --quiet`、`status --short`、`status --porcelain`、`status --short --branch`、`worktree list --porcelain`、`rev-list --count`、`merge-base --is-ancestor`、`diff --name-only HEAD`、`diff --name-only --diff-filter=U` |
| 工作树 | `worktree add`、`worktree remove [--force]`、`worktree prune` |
| 分支与合并 | `branch -d`、`branch -D`、`merge --no-ff --no-edit <ref>`、`merge --abort`、`reset --hard <sha>` |

## 依赖

| 依赖 | 用途 | 提供方 |
| --- | --- | --- |
| Node.js `>=22.19.0` | 运行时（`package.json` 的 `engines.node`） | 用户环境 |
| DSH `>=0.2.0-rc.1 <0.3.0-0` | 宿主：客户端契约与服务注入（`engines.dsh` / `dsh.compatibility.dsh`，声明式） | 用户环境 |
| `@deepseek-ai/cordis` `^4.0.2` | 插件框架 | DSH profile（`peerDependencies`） |
| `@deepseek-ai/dsh-client-connection` `>=0.2.0-rc.1 <0.3.0-0` | 客户端连接与宿主 RPC（`/api/dsh-worktree-space`）；DSH 0.2.0 起安装与启动会强制校验这个范围 | DSH profile（`peerDependencies`） |
| `@deepseek-ai/dsh-tools` `>=0.2.0-rc.1 <0.3.0-0` | 宿主工具定义 `defineTool`；同样被 DSH 强制校验 | DSH profile（`peerDependencies`） |
| `@deepseek-ai/schemastery` `^3.18.2` | 配置模式校验 | DSH profile（`peerDependencies`） |
| `react` / `react-dom` 18 | 客户端界面，打包时按 external 处理 | DSH web 运行时 |
| `git` | 全部仓库操作 | 用户环境（须在 `PATH`，版本随系统） |
| `@hugeicons/core-free-icons`、`@hugeicons/react`、`@radix-ui/react-dialog` | 图标与对话框组件，**仅构建期**，已内联进 `client/client.js` | 构建机（`devDependencies`） |

运行期第三方依赖为 **0**：`package.json` 里没有 `dependencies`，`scripts` 中没有 `preinstall`/
`install`/`postinstall` 等生命周期脚本，仓库内没有预编译二进制或可执行产物。

## 文件权限信号说明

- 不使用 `chmod`/`chown`/`utimes`，不设置 `mode`，不设置 setuid/setgid/sticky 位；新建文件与目录使用
  Node 默认权限（受 umask 约束）。
- 不创建符号链接或硬链接。
- 不包含 `.exe`/`.node`/`.dll`/`.so` 等原生或可执行产物；npm 包内容由
  `scripts/check-package-contents.mjs` 按逐项白名单（`npm pack --dry-run`）校验。
- 不读取环境变量中的密钥，不写用户 home 目录。

## 失败边界（结构化，绝不静默）

| 情形 | 行为 |
| --- | --- |
| 扫描目录数超过 `maxScanDirectories` | 中止该次扫描并提示 `Worktree scan limit reached; choose a more specific Workspace.`，不返回半份结果 |
| `git` 不存在或无法启动 | `subprocess.spawn` 的错误向上抛出，该请求以失败结束，界面显示 git 的诊断原文 |
| 任何 `git` 子命令非零退出 | 抛出 `git <args> failed (exit N): <stderr>`，保留 git 原文；查询类调用（`tryRunGit`/`gitSucceeded`）把失败降级为「未知 / 否」，但不改动仓库状态 |
| 创建时某个仓库开 worktree 失败 | 该仓库记为失败，其余仓库照常创建；已建成的部分如实报告，不静默回滚 |
| 结束任务时某个 worktree 还有未提交的改动 | 停下该仓库（`force` 表示调用方说「这些改动不要了」）：报 `uncommitted work is waiting in <worktree>; commit it before the task can be finished`，**不代写提交**；其余仓库继续，结果里逐条报出 |
| 合并已解决但还没有提交 | 不代为提交：报 `the merge in <worktree> is resolved but not committed`，现场原样保留，等它的解决者提交 |
| 解决后的文件里还留着冲突标记 | 报 `the resolved merge still has conflict markers in <files>`，原样保留，不替任何一方取舍 |
| 合并冲突 | 不中止、不还原，冲突现场原样留在对应 worktree（保留 `MERGE_HEAD` 与未解决文件）；整体记为部分完成（`failed: true`），返回 `mergeSite` 与 `conflictedFiles`，等用户交由 agent 解决 |
| 移除 worktree 失败 | 报 `failed to remove the worktree (uncommitted changes? force it deliberately)`（并用 `worktree prune` 作为补救），任务空间目录与工作区注册保留，绝不强行删除目录 |
| 归档复制失败 | 报错并保留源文件，不删除任务空间 |
| 工作区里仍有会话在运行 | 拒绝结束任务，等该会话结束或被停掉后重试 |
| 配置关着时收到放宽会话权限的请求 | 拒绝并回 `E4012`，**不写任何事件**（配置里那一项关着就是关着）；请求没指明会话则回 `E4011` |
| 会话服务不可用、或那个会话已经不在 | 如实回答「没有放宽」，交接照常进行；面板据此说明该会话拿到的实际权限，不假装设置生效 |
| 任务空间目录里还有内容 | 不删除任务空间目录、不注销工作区 |
| 无法确认的信息 | 本文件与 `README.md` 一律写明「未知 / 未验证」，不把「没有搜到」当成「不访问」 |

## 与 DSH STORE 契约的关系

- **供应链**：运行期第三方依赖为 0；4 个 `peerDependencies` 全部由 DSH profile 提供；`@hugeicons/*` 与
  `@radix-ui/react-dialog` 只在构建期使用并已内联进 `client/client.js`。无生命周期脚本、无原生制品、
  无子模块、无符号链接，包内容有逐项白名单校验。
- **权限信号**：本插件的功能就是**文件读写**与**命令执行**（调用 `git`），因此**无法**满足 DSH STORE
  「文件 / 网络 / 命令 / 凭据信号均为空」的自动批准条件。本文件的作用是把这些信号如实、完整地声明出来，
  供人工复核与上架详情展示 —— 高权限项目的正确状态是「已声明的高权限」，而不是「看起来没有权限」。
- **固定提交**：`2b732bc`（`feat: a settings shortcut in the navigation, the feedback link on the panel,
  and the flow under the heading`）—— 兼容性矩阵实测安装的那份产物（`dsh-worktree-space-1.2.1.tgz`）里
  两份构建产物与这个提交的逐字节一致，`store-evidence.md` 第 5 节里所有行都出自这一轮。发布提交
  （版本号、CHANGELOG、本文件与证据文档）在它之后，构建产物逐字节不变。标签 `v1.2.1` **尚未推送**；
  一旦推上去，应当指向发布提交——它带着与 `2b732bc` 相同的构建产物，否则证据指向的就不是发布的那份产物了。
- **生命周期**：一次性 Profile 的安装、启动与卸载验证步骤及当前证据见 `docs/store-evidence.md`。


---

<a id="english"></a>

# PERMISSIONS — dsh-worktree-space permissions and failure boundaries

**English** · [简体中文](#chinese)

This file exists for DSH STORE's automated review and for human re-review: it states plainly what this
plugin does at runtime, what it does not do, and where it stops.

Declared baseline: `dsh-worktree-space@1.2.1`, at the fixed commit on this repository's default branch. The plugin version, `engines` and `dsh` fields are in `package.json`.

## Runtime behaviour

- **Purpose**: make "one task spanning several repositories" a Workspace beside the repositories'
  directory — never inside it, never above it. Every
  selected repository gets its own `git worktree` at `<container root>/<project>/<task>/<repository>`, all on
  the same task branch; the **project** layer is one the plugin derives from the source Workspace's own
  directory name, so there is nothing for the user to fill in; `<container root>/<project>/<task>` is
  registered as a DSH Workspace and opened with a session whose working directory is the task space.

- **Reads**:
  - The Workspace directory tree, read-only: a breadth-first `readdir` walk, at most `scanDepth` levels
    (1–5, default 3) and at most `maxScanDirectories` directories (default 2000), reading up to eight
    directories at a time per level. `node_modules`, `Library`, `dist`, `build`, `vendor` and hidden
    directories are skipped (except `.worktrees`). The scan only decides *which directory is a Git
    repository* — it **does not read file contents**.
  - The two records in the task space's own directory: `.worktree-space/worktree-space.json` and
    `.worktree-space/worktree-space.md`, plus the files under the deploy root inside it (scripts, manifest,
    `.state.json`); and each repository
    worktree's `<worktree>/.git` marker file (used to tell whether that worktree has gone stale).
  - The container root's `<container root>/.git` and `<container root>/README.md`: the first, if present,
    means the container root is itself a Git repository and creation is refused; the second, if present, is
    never written over. Both are existence checks only.
  - `assets/skill/worktree-space/SKILL.md` inside this package (registered as a bundled skill, read
    only, never copied anywhere).
  - The paths the user chooses (source root; the Worktree Space container root, either typed into the create dialog
    or named by the Custom Worktree Space container root setting; and the archive directory).
  - On finish, the **contents** of the files git lists in a worktree through `git diff --name-only HEAD` and
    `git diff --name-only --diff-filter=U`: each is read back only to decide whether a merge still carries
    conflict markers (line by line, for lines starting with `<<<<<<<`, `=======` or `>>>>>>>`). A listed path
    that cannot be read (a submodule, a directory) is skipped. Nothing but those markers is inspected, and no
    content is written to a log or a response.

- **Writes**: only inside the task space directory the user chose, its archive directory, the one directory
  identified as a stale worktree, and one merge checkout the plugin creates under the **system temporary
  directory** (below); **never** into the files of a source repository's checkout, and never into the DSH
  installation or a configuration file.
  - Create: `mkdir` the container root, the project directory beneath it and the task space directory; write
    one `README.md` at the container root the first time it is used (declaring it the worktree-only area;
    an existing one is left alone); `git worktree add` creates each checkout (git writes it); write
    `.worktree-space/worktree-space.json` and the `.worktree-space/worktree-space.md` rendered from it, and
    copy the source root's whole `.worktree-space/deploy/` to the same relative place in the task space
    (scaffolding a state-writing script when the source root has none).
  - Archive: `cp` the task space's documents to `<project>/<task>-<YYYYMMDD-HHMMSS>/` under the **archive
    root** the configuration names; the default root is the task space's **own container root**
    (`<container root>/archived-docs`, the very directory chosen when the task space was created), and it
    can also point at any directory you choose.
  - Clean up: `git worktree remove --force` removes a checkout; a **stale worktree** whose `.git` points at a
    gitdir that no longer exists has that one directory removed with `fs.rm(directory, { recursive: true })`;
    the task space directory itself is deleted and its Workspace registration removed only once it really is
    empty.
  - Merge: when the target branch is the one the source repository has checked out, the merge runs in place
    there (`git merge`, which writes that repository's own branch and working tree). Otherwise the plugin
    `mkdtemp`s `os.tmpdir()/dsh-worktree-space-merge-<random>/`, runs `git worktree add` for a temporary
    checkout of the target branch inside it, merges there, then `worktree remove --force` (falling back to
    `worktree prune`) and `rm`s the whole temporary directory — a merge that already succeeded is not reported
    as failed because that directory would not delete.
    **What triggers it**: normally the user's own hand — the panel's tick, or an agent passing `merge: true`
    after being told to merge. When the task's record carries `merge.mode: auto` (that project's standing
    authorisation, recorded when the task was created), the finish merges **without waiting for a press**. The
    opposite value, `never`, refuses a `merge: true` from the tool (`E4013`): only the user's own hand in the
    panel merges that task.
  - Rehearsal: a finishing run that has to merge first rehearses the merge inside **that repository's own
    worktree in the task space**. A conflict is left there as it stands; a clean rehearsal is `reset --hard`
    back to the commit recorded before it, after which the step above records the merge on the target branch.
  - Operation log: one line of JSON appended with `fs.appendFile` to **`worktree-space-log.jsonl` at the
    container root**; described below.
  - git's own bookkeeping: `git worktree add/remove` writes git's own registration and index under
    `<source repo>/.git/worktrees/<name>/` (the `.git` marker, `HEAD`, `index`, …). That is git's doing; the
    plugin never edits files in a source repository's checkout.
  - Configuration (the entry switches, scan depth, default branch prefix, Worktree Space container root, archive
    location) is stored by
    DSH's own plugin configuration service (the Plugins page's live form); **the plugin writes no
    configuration file**, and its `task.preference` endpoint is read-only.
  - Workspace registration: when a task space is created — the panel's Create and open, or the agent tool's
    `create` — it is **registered** as a Workspace through DSH's own workspace service, and a finish that really
    removes the directory **unregisters** it. That writes **DSH's own store**, not a file this plugin writes.
    **The interface has no switch for either**: building one in the panel registers it, and finishing there
    unregisters it. **A tool call says so per call**: `create` with `registerWorkspace: false` does the disk
    half only (the task space is made and stays out of the workspace list), and `done` with
    `unregisterWorkspace: false` keeps the registration (its sessions stay in that group). An unregistration
    goes by **what the list says now**: a failed delete is followed by reading the list again, and only an entry
    that is still there is reported as a failure — one that has gone is the outcome, not a problem.
  - Sessions: the tool's `create` with a `prompt`, or `action: "dispatch"`, **opens a session** in the task space
    through DSH's own session service and appends one `sandbox/mode` policy event to **that session's own log**
    (by default the calling session's **own explicit override** is copied; with no override, none is written and
    the new session lands on the deployment default, so it is never wider than the caller). The turn of work is
    then delivered to it as a prompt. Both actions are the caller's per-call decision; the interface's Create and
    open, and its handoff buttons, are a different route. What is written is DSH's own store and the session log,
    not a file this plugin writes. With no session service in the deployment, **nothing is opened and nothing
    fails**: the tool answers that no session was opened, and says to open one from the panel.
  - The session-control tool (`wts_session_tool`): **reading** any session's event log (a live one through the
    host's session service, an offline one through session persistence — the same records the panel reads),
    **sending** a message to a session (`steer` injects into the running turn, `queue` appends a turn),
    **opening** and **resuming** sessions, and **aborting** a session's active turn. What is written is **DSH's
    own session log**, not a file this plugin writes. All eight are the **caller's per-call decision**: the plugin
    polls nothing on its own, never steers by itself, and never terminates a session by itself. Where the
    deployment serves no such service it **does not fail** — each tool answers "this deployment does not offer X",
    and the tool itself is registered all the same. The session id recorded when a task space is dispatched (the
    `sessions` field of `.worktree-space/worktree-space.json`) goes into this plugin's own task record, which is the same
    boundary as above.

- **Command execution**: `git` is invoked through the host's `subprocess` service with a **fixed argv**
  (`argv: ['git', '-C', <cwd>, ...args]`): **no shell**, no string interpolation, no user-supplied command,
  and no executable other than `git`. Every subcommand is listed in the table below.

- **The plugin does not commit**: `git add` and `git commit` are **not in this plugin's command table**. When
  a worktree still holds uncommitted work at finish, that repository stops and is named (see the failure
  boundaries) — the plugin writes no commit for it. "Hand the commit to an agent" means the plugin **opens a
  separate session**, in which the **host's agent** runs `git add` / `git commit`: those commands are not
  issued by this plugin and are not part of its permission signals.

- **Session access (off unless the user turns it on)**: both of those handoffs open **separate sessions**. By
  default the plugin picks a working directory that reaches **both the worktree and the source repository's
  `.git`**, so the session stays inside DSH's sandbox: writing outside that directory — a source repository's
  git metadata, for instance — is refused by the sandbox and handled by DSH's own elevation approval. **The
  plugin neither proxies nor bypasses it.**

  With the setting **Full access for the sessions handed to the agent for conflicts and commits**
  (`handoffFullAccess`, `off` by default) on, the plugin does two more things to **the sessions it has just opened
  for a handoff**:
  - the working directory becomes the **container root** (`<container root>`), so those sessions belong to the
    Workspace the plugin registered rather than to Ungrouped;
  - immediately after the session exists, two events are appended to **that session's own log**: `sandbox/mode`
    at `danger-full-access`, and `approval/policy` at `never`. Both are written because DSH's own table treats
    them as **one preset**, whose name is "full access" and whose meaning is "Full file access without approval
    prompts". Writing only the first leaves a pair that matches no preset (the interface reads it as `custom`),
    and any approval request that does arise would be put to the user — which is not what that preset means.

  The consequence is what those events say: **that session may then write anywhere the DSH process can**, and
  there are no approval prompts in it. They are durable state in the session log, reconstructed by replay across
  a restart, and their scope is **that session** — not the deployment, not any other session.

  Boundaries: it happens only when the setting is `on`; the setting is **re-read before each write** and a
  request that arrives while it is off is refused (`E4012`) without writing anything; those two events are the
  only ones written, and nothing else about the session is touched; and it applies only to sessions the
  plugin has just opened for a handoff. **A session already open is not affected by a later change to the
  switch** — that one is switched in its own session, with DSH's own `/permission`.

- **Network**: the plugin itself issues **no HTTP request at all** and runs **no `git push`**. Every `git`
  subcommand it runs is local (see the table below) and writes no remote ref. Git's own credential helpers and
  proxy settings are outside this plugin's control.

- **Credentials/keys**: the plugin **does not read, store or forward** credentials. It does not read
  `process.env`, `~/.git-credentials`, `~/.ssh`, `.netrc` or an OS keychain, and it writes no credential into a
  log or a response.

- **Operation log**: **`worktree-space-log.jsonl` at the container root**, a JSONL file that is only ever
  appended to, never rewritten and never deleted. One line per `git` call that changes repository state, per
  failing `git` call, and per error or warning: `ts` (ISO time), `kind` (`git` / `error` / `warning`), `op`
  (the endpoint), `task`, `project`, and that record's own fields — `argv`, `cwd`, `exit` and `stderr` (past
  2 KB truncated) for a command, `message`, `stack`, `code` and the repository and phase it happened in for an
  error.
  - **Only paths, commands and git's own diagnostic text are recorded. No file contents**, and no file
    content is read in order to record one.
  - Credentials inside a URL are replaced with `***` before the write (`https://user:token@host/x` becomes
    `https://***@host/x`); an `@` in a path is left alone.
  - A successful **read-only** `git` call is not recorded (`status`, `rev-parse`, `for-each-ref` and the
  like); a state-changing command and **any failure** are, including one whose failure the caller was going
  to swallow — such as the query that asks whether a branch already exists.
  - **It writes only where the container root already exists, and never creates a directory.** There the
    append fails and is ignored, so calls that belong to no task space — `worktree.scan`, `worktree.status` —
    record nothing at all.
  - Any failure of the write itself (file deleted, directory read-only, disk full) is swallowed and **changes
    no outcome of any operation**. The write is `await`ed: the record is on disk when the call returns, in
    the order the commands ended.
  - Past 10 MB the current file is renamed to `worktree-space-log.<YYYYMMDD-HHMMSS>.jsonl` and a new one
    starts; **the old file is kept**.
  - **No endpoint reads it and it leaves this machine**: nothing is sent, uploaded or returned.
  - Deleting the container root deletes the log with it. It is not a backup and not an audit record.

- **External services**: none. No account, no server, no telemetry.

- **Global resources**: no global packages installed, no daemon, no system service, no permission changes, no
  symbolic links; the scan cache lives in the DSH instance's memory only and is gone when the instance exits.

  That last one has one exception, recorded here so this file and the code agree: **asking whether this machine
  will let the process create a symbolic link means actually creating one under a temporary directory and
  deleting it** (`symlinksRefused` in `links.js`). The question is what the machine's policy is, so the only
  way to ask it is to try; the probe is made with `mkdtemp(tmpdir())` and removed recursively immediately
  after. It **changes no permission on any user file, and touches neither the task spaces nor the source
  root** - so it does not conflict with the intent of "no symbolic links", which is about not creating them
  for the user's own content. It is a real creation outside that intent, hence named here. It runs once per
  process.

### Every git subcommand invoked

| Kind | Subcommands |
| --- | --- |
| Queries (read-only) | `rev-parse --show-toplevel`, `rev-parse --git-common-dir`, `rev-parse --abbrev-ref HEAD`, `rev-parse HEAD`, `rev-parse --verify --quiet <ref>^{commit}`, `rev-parse --verify --quiet MERGE_HEAD`, `symbolic-ref --quiet --short refs/remotes/origin/HEAD`, `for-each-ref --format=%(refname:short) <refs>`, `show-ref --verify --quiet`, `status --short`, `status --porcelain`, `status --short --branch`, `worktree list --porcelain`, `rev-list --count`, `merge-base --is-ancestor`, `diff --name-only HEAD`, `diff --name-only --diff-filter=U` |
| Worktrees | `worktree add`, `worktree remove [--force]`, `worktree prune` |
| Branches and merges | `branch -d`, `branch -D`, `merge --no-ff --no-edit <ref>`, `merge --abort`, `reset --hard <sha>` |

## Dependencies

| Dependency | Purpose | Provided by |
| --- | --- | --- |
| Node.js `>=22.19.0` | Runtime (`engines.node` in `package.json`) | The user's environment |
| DSH `>=0.2.0-rc.1 <0.3.0-0` | Host: client contract and service injection (`engines.dsh` / `dsh.compatibility.dsh`, declarative) | The user's environment |
| `@deepseek-ai/cordis` `^4.0.2` | Plugin framework | DSH profile (`peerDependencies`) |
| `@deepseek-ai/dsh-client-connection` `>=0.2.0-rc.1 <0.3.0-0` | Client connection and host RPC (`/api/dsh-worktree-space`); from DSH 0.2.0 on, install and startup enforce this range | DSH profile (`peerDependencies`) |
| `@deepseek-ai/dsh-tools` `>=0.2.0-rc.1 <0.3.0-0` | Host tool definition, `defineTool`; enforced by DSH the same way | DSH profile (`peerDependencies`) |
| `@deepseek-ai/schemastery` `^3.18.2` | Configuration schema validation | DSH profile (`peerDependencies`) |
| `react` / `react-dom` 18 | Client UI, marked external at bundle time | The DSH web runtime |
| `git` | Every repository operation | The user's environment (must be on `PATH`; version follows the system) |
| `@hugeicons/core-free-icons`, `@hugeicons/react`, `@radix-ui/react-dialog` | Icon and dialog components, **build time only**, already inlined into `client/client.js` | The build machine (`devDependencies`) |

Third-party runtime dependencies are **zero**: `package.json` carries no `dependencies` key, `scripts` holds
no `preinstall`/`install`/`postinstall` lifecycle script, and the repository contains no prebuilt binary or
executable artifact.

## File-permission signals

- No `chmod`/`chown`/`utimes`, no `mode`, no setuid/setgid/sticky bit; new files and directories get Node's
  default permissions (subject to umask).
- No symbolic or hard links are created.
- No native or executable artifact (`.exe`, `.node`, `.dll`, `.so`) is shipped; the npm package contents are
  checked against a deliberate allowlist by `scripts/check-package-contents.mjs` (`npm pack --dry-run`).
- No secret is read from the environment, and no user home directory is written.

## Failure boundaries (structured, never silent)

| Situation | Behaviour |
| --- | --- |
| More directories than `maxScanDirectories` | That scan stops and reports `Worktree scan limit reached; choose a more specific Workspace.`; no half result is returned |
| `git` missing or cannot be started | The `subprocess.spawn` error is thrown up; the request fails and the UI shows git's own diagnostic |
| Any `git` subcommand exits non-zero | Throws `git <args> failed (exit N): <stderr>` with git's text preserved; the query helpers (`tryRunGit`/`gitSucceeded`) degrade a failure to "unknown/no" without changing repository state |
| One repository's worktree fails during create | That repository is reported failed, the others are still created, and what was built is reported as it stands — no silent rollback |
| A worktree still holds uncommitted work at finish | That repository stops (`force` is the caller saying "these changes can go"): it reports `uncommitted work is waiting in <worktree>; commit it before the task can be finished` and **writes no commit**; the others carry on and the result names each one |
| A merge is resolved but not committed | Not committed for you: reports `the merge in <worktree> is resolved but not committed` and keeps the state as it stands until whoever resolved it commits |
| The resolved files still carry conflict markers | Reports `the resolved merge still has conflict markers in <files>` and keeps them as they stand — it takes no side |
| A merge conflicts | Not aborted and not reverted — the conflict stays in that worktree (keeping `MERGE_HEAD` and its unresolved files); the finish reports partial success (`failed: true`) with `mergeSite` and `conflictedFiles` and waits for the user to authorise an agent |
| Removing a worktree fails | Reports `failed to remove the worktree (uncommitted changes? force it deliberately)` (with `worktree prune` as the remedy); the task space directory and the Workspace registration stay, and the directory is never force-deleted |
| Archiving fails to copy | Reports the error and keeps the source files; the task space is not deleted |
| A session in that Workspace is still running | Finishing is refused until that session ends or is stopped |
| The task space directory still holds anything | The directory is not deleted and the Workspace stays registered |
| Something cannot be confirmed | This file and `README.md` say "unknown / unverified" rather than reading "not found" as "does not access" |
| A request to widen a session arrives while the setting is off | Refused with `E4012`, and **no event is written** — off means off; a request that names no session is answered with `E4011` |
| No session service, or the session has already gone | Answered as "not widened" and the handoff carries on; the panel says which access the session actually got instead of pretending the setting took effect |

## Relation to the DSH STORE contract

- **Supply chain**: zero third-party runtime dependencies; all four `peerDependencies` are provided by the
  DSH profile; `@hugeicons/*` and `@radix-ui/react-dialog` are build-time only and already inlined into
  `client/client.js`. No lifecycle script, no native artifact, no submodule, no symlink, and the package
  contents are checked against an explicit allowlist.
- **Permission signals**: file access and command execution (`git`) *are* what this plugin does, so it
  **cannot** satisfy DSH STORE's automatic-approval condition of empty file/network/command/credential
  signals. The point of this file is to declare those signals completely and honestly for human re-review and
  for the listing details — the correct state for a high-capability project is "declared high capability",
  not "apparently no capability".
- **Fixed commit**: `2b732bc` (`feat: a settings shortcut in the navigation, the feedback link on the panel,
  and the flow under the heading`) — the build artifacts inside the tarball the compatibility matrix actually
  installed (`dsh-worktree-space-1.2.1.tgz`) match this commit byte for byte, and every row in section 5 of
  `store-evidence.md` comes from that run. The release commit (version, changelogs, this file and the
  evidence document) follows it with the build artifacts byte-identical. The tag `v1.2.1` has **not been
  pushed**; when it is, it must point at the release commit — it carries the same build artifacts as
  `2b732bc`, or the evidence describes an artifact other than the one released.
- **Lifecycle**: the disposable-profile install, start and uninstall steps, with the evidence available today,
  are in `docs/store-evidence.md`.

