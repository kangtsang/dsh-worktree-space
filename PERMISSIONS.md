# PERMISSIONS — dsh-worktree-space 权限与失败边界声明

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
  - 任务空间里的两个插件元数据文件 `worktree-space.json`、`worktree-space.md`；以及每个仓库 worktree 的
    `<worktree>/.git` 标记文件（用于判断该 worktree 是否已经失效）。
  - 容器根的 `<容器根>/.git`（存在就说明容器根本身是 Git 仓库，创建会被拒绝）与 `<容器根>/README.md`
    （存在就不再写，绝不覆盖用户自己写的内容）。两者都只做存在性判断。
  - 本插件自己包内的 `assets/skill/task-worktree-space/SKILL.md`（作为内置技能注册，只读，不复制到别处）。
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
    写 `worktree-space.json` 与由它渲染出的 `worktree-space.md`。
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

  配置项**「交由 agent 处理冲突和提交的会话使用完全访问」**（`handoffFullAccess`，默认 `off`）打开后，插件对**自己刚刚为交接
  开出的**那两个会话多做两件事：
  - 工作目录取**容器根**（`<容器根>`），因此这些会话归属于插件注册的那个工作区分组，而不是未分组；
  - 会话建立之后立即向**该会话自己的日志**追加一条 `sandbox/mode` 事件，把它的沙箱模式置为
    `danger-full-access`。

  这条事件的后果就是它的字面意思：**那个会话此后可以写到 DSH 进程能写的任何位置**，不再逐次询问。它是会话
  日志里的**持久**状态，重启后按 replay 依然生效；作用域是**那个会话**，不是部署，也不是别的会话。

  边界：只在配置为 `on` 时发生；每次写入前**重新读一次该配置项**，关着就拒绝（`E4012`），不写任何事件；只写
  `sandbox/mode` 这一种事件，不碰会话的其它任何状态；只针对插件自己刚刚为交接开出的会话。**已经开出来的会话
  不受之后开关变化的影响**——要改就在那个会话里用 DSH 自己的 `/permission`。

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
| DSH `>=0.1.7-rc.1 <0.3.0-0` | 宿主：客户端契约与服务注入（`engines.dsh` / `dsh.compatibility.dsh`，声明式） | 用户环境 |
| `@deepseek-ai/cordis` `^4.0.2` | 插件框架 | DSH profile（`peerDependencies`） |
| `@deepseek-ai/dsh-client-connection` `>=0.1.7-rc.1 <0.3.0-0` | 客户端连接与宿主 RPC（`/api/dsh-worktree-space`）；DSH 0.2.0 起安装与启动会强制校验这个范围 | DSH profile（`peerDependencies`） |
| `@deepseek-ai/dsh-tools` `>=0.1.7-rc.1 <0.3.0-0` | 宿主工具定义 `defineTool`；同样被 DSH 强制校验 | DSH profile（`peerDependencies`） |
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

## 对应语言版本

- 简体中文：本文件
- English: [`PERMISSIONS.en.md`](PERMISSIONS.en.md)
