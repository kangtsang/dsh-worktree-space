<a id="chinese"></a>

# 更新日志

**简体中文** · [English](#english)

记录每个版本的改动。更早的版本只留在 git 历史里；宿主兼容性的逐版本实测证据在
[`store-evidence.md`](store-evidence.md)。英文版见[本文档英文部分](#english)。

## 1.3.6 — 2026-10-25

工作区右键菜单可以直接在文件管理器或编辑器里打开目录，添加工作区与仓库改为选择目录。

### 新增

- **工作区的右键菜单多了「在文件管理器中打开」和「在应用中打开」。** 后者是一个二级菜单，列出这台
  机器上装了什么——IntelliJ IDEA、GoLand、PyCharm、VS Code 之类，点一项就在那个应用里打开这个
  工作区目录。列表来自系统自己的注册信息，所以装在非默认位置的应用也能找到。

  这两项都由宿主执行，不是插件自己去启动程序：插件进程跑在宿主的隔离边界里，而文件管理器把请求
  交给已在运行的系统 shell 就退出了，窗口会在它出现之前被一起收掉——这正是第一版「点了没反应、
  也不报错」的原因。

- **添加工作区、添加仓库改为选择目录。** 原来要手输路径，现在旁边有「浏览…」，打开的是宿主自己的
  目录选择器（和它在别处用的是同一个）。选完路径填进输入框，取消则什么都不改。宿主没有提供选择器
  时，输入框仍可手打，功能不丢。

### 修复

- **二级菜单的展开方式。** 一开始是点击展开，但宿主在自己的菜单项被点击时会关掉菜单，于是按下
  父项后一级菜单消失、子菜单留着，必须先选一个才能回去。改为悬停展开。

- **二级菜单的存活。** 它曾挂在页面根节点上，鼠标移过去就等于离开了一级菜单，两者一起关闭。现在
  它嵌在一级菜单内部（视觉位置不变），移动到子菜单不再算离开。

- **二级菜单的背景。** 背景色原先从一个通常透明的元素上读，导致子菜单透出后面的内容；现在取真正
  画了底色的那一层，与一级菜单一致。

- **悬停提示气泡偶尔不消失。** 气泡不接收鼠标事件，所以「鼠标离开」这条不够用：触发它的元素被
  重新渲染或移除时根本不会触发。现在鼠标移到别处、任意位置按下、窗口失焦、或元素被移除，都会收起。

## 1.3.5 — 2026-10-24

结束任务面板打开更快，工具返回会说明下一步该做什么。

### 新增

- **工具返回里给出下一步。** 工具说明只在开头读一次，一个已经决定「这点活顺手就做了」的 agent
  不会再回去翻它。现在四个节点会在返回里说明默认流程——任务的实现属于任务空间里的会话，不属于
  当前会话，只有用户明确要求时才在当前会话里做：
  - `create` **没带 `prompt`**：空间建好了却没有会话在上面，返回里给出可直接照抄的 `dispatch` 调用；
  - `suggest-root`：下一个调用应该是一个带 `prompt` 的 `create`；
  - `add` 且记录里没有会话、`list` 且所有任务都没有会话：说明该把活派出去。

  带了 `prompt` 的 `create`、`dispatch`、`done` 不追加任何话——那已经是引导想达到的结果。

### 变更

- **结束任务面板的加载变快。** 原先每个仓库的几条 git 查询是串行的，Windows 上每次 `git.exe`
  启动几乎全是进程创建开销，三个仓库就是二十一次串行的进程启动。现在仓库之间并行（仓库内部
  仍串行，因为后一问依赖前一问），并去掉了对同一个仓库重复问一次的 `rev-parse`。合成四仓库
  实测约 700ms → 206ms。

- **`done` 收尾也变快。** 收尾前对每个仓库的只读探测（分支、源仓库、是否有合并停在半路、
  有没有未提交的改动）现在并行执行；合并、移除、删分支这些有副作用的动作仍然逐个串行，因为
  一个仓库的失败不该影响另一个。合成仓库实测三个仓库 722ms → 333ms，五个仓库
  1179ms → 434ms。

- **`resolveMergeTarget` 新增可选的第五个参数**：调用方已经读到的分支可以直接传入，省掉一次
  重复查询。省略时照旧自己问，既有调用方不受影响。

## 1.3.4 — 2026-10-22

移除「等待会话」这一能力。

### 变更

- **`wts_session_tool` 不再有 `wait` action，`send` 与 `create` 也不再接受 `waitForReply`。**
  队长会话在会话上阻塞等待时，既无法接收用户的下一条指令，也无法对它等待期间到达的回报作出反应——
  而回报本身就是由任务会话主动发出的，回合异常结束也会由监听器推送给派单方，所以等待没有存在的必要。

  随之移除的还有 `timeoutMs` 与 `requireTurnEnd` 两个参数：它们只为给一次阻塞设上界而存在。

  不阻塞的那一半足以覆盖同样的用途：`status` 靠会话自己的时钟分辨「卡住」与「在跑长步骤」，
  `read` 看它究竟说了什么，`send` 继续指挥它。`read` 的 `sinceSeq` 保留——它在那里是翻页游标，
  从来不只是等待的参数。

  **这是对调用方的破坏性变更**：仍在传 `waitForReply` 或调用 `wait` 的一方会收到参数校验错误。
  正确做法是 `send` 之后不再等待，而是在有理由时用 `status` / `read` 查看一次。

## 1.3.3 — 2026-10-21

把九个工具收成两个，把技能拆成按阶段加载，并让常规部署不再需要读技能。

### 变更

- **会话控制的八个工具合成一个。** `wts_session_tool_find` / `_status` / `_read` / `_send` /
  `_create` / `_resume` / `_wait` / `_cancel` 现在是 `wts_session_tool` 的八个 action，用
  `action` 参数选。原来八份描述各自重复的「会话 id 从哪来」「哪些 action 需要在线会话」
  「`sinceSeq` 是干什么的」现在只说一遍，八个能力一个没少。

  参数名有三处调整，都是为了不再一词两义：`find` 的 `title` / `cwd` / `limit` 改名为
  `titleMatch` / `cwdMatch` / `resultLimit`——它们与 `create` 的 `title`、`cwd` 和 `read` 的
  `limit` 含义不同，合成一个工具后同名会让调用方猜。

### 新增

- **技能按阶段加载。** `SKILL.md` 变成一张路由表，正文按「创建 / 工作 / 收尾 / 冲突 / 部署 /
  故障」拆进六份 `references/`，走到哪一步才加载哪一份。只想建个任务空间再派单的会话，不必
  先读完一整份技能。

- **常规部署不必再读技能。** 任务的 `.worktree-space/worktree-space.md` 里已经写着这个任务的
  部署入口、`DEPLOY_ENV_ID` 和闸门读的那个状态文件；工具描述现在直接指向它。部署脚本已经写好、
  之前跑通过的任务，照着那份文件里的命令跑即可——**只有要新写或修一个部署入口时才需要看
  `references/deploying.md`**。

- **派单出去的任务开工前先回报一次。** 队员会话在动手写代码之前，要说清它理解的任务是什么、
  打算动哪些仓库和文件。理解偏了，这一步一句话就能纠正；等到收尾才发现，就是一个没人要的成品。

### 修复

- 打包清单守卫漏登记了六份新增的 `references/` 文件。它们本来就会进包（`files` 声明的整个
  `assets/` 目录），但那份清单是防止无关文件混进包的闸门，漏登记等于开了个口子。

## 1.3.2 — 2026-10-20

给部署验收的两个步骤加上可调的等待时限，并把宿主兼容窗口收窄到 0.2.0。

### 新增

- **部署入口可以自报等待时限。** 插件原先固定等 `up` 最多 10 分钟、`smoke` 最多 5 分钟，
  到点就停掉脚本，没有地方改。冒烟真的要跑更久的任务，只能去改插件源码或缩短冒烟。
  现在入口可以加一个 `timeouts` 子命令，打印一行 JSON 交出两个秒数：
  `{"upSeconds":1200,"smokeSeconds":900}`。插件在跑每一步之前先问一次，用那个数字当
  这一步的时限；两个键都可省略，省略的沿用默认值。

  这个子命令可以永远不加。脚本没实现它、退出码非零、输出不是 JSON、数值落在 1–3600 秒
  之外，任何一种都当作没回答，沿用默认时限——**它只改插件等多久，不改这一步跑不跑**。

### 兼容性

- **不再支持 0.1.7 系列。** 兼容下界从 `0.1.7-rc.1` 提到 `0.2.0-rc.1`：`engines.dsh`、
  两个 peer 依赖（`dsh-client-connection`、`dsh-tools`）与 `dsh.compatibility.dsh` 四处同步
  收窄，实测窗口相应变为四个版本。宿主仍停在 0.1.7 的请继续用 1.3.1。

### 文档

- 中文 README 增加插件的 B 站介绍视频。

## 1.3.1 — 2026-10-18

修掉 Docker 部署验收与冲突交接上的几处问题，并补上两项文档。

### 修复

- **Windows 上「部署」「冒烟测试」不再报「脚本不存在」。** Windows 上的 `bash` 不是 shell，
  读不懂 `D:\...` 这种本机路径，于是把明明在盘上的部署入口报成 `No such file or directory`。
  插件现在自己挑一个真正的 shell；找不到时会直接说明原因。
- **部署入口拿不到自己的工具。** 上面的修复让脚本第一次真正跑起来，随即暴露出脚本里
  `dirname` 找不到的问题——shell 按绝对路径启动时不会自动带上同目录的那些工具。插件现在
  把它们一并交过去。
- **「冒烟测试」「销毁环境」两个按钮不见了。** 容器被部署脚本按它自己的默认 id 打标签，
  插件按本任务的 id 找不到，就认为没有容器。任务空间 note 里的 `up`、`smoke` 现在都带上
  这个环境 id。
- **冲突交给 agent 时多出一条用不上的工作区。** 交接会话原先开在容器根上，于是那条以所有
  项目名义的分组留在工作区列表里。现在开在任务空间本身，收尾删掉任务空间时一并删除。
- **冲突会话没有归到任务空间下面。** 会话开在一个已经是工作区的目录上时不会自己加入，
  所以它工作目录正确却落在「未分组」。插件现在显式把它放进那条分组。

### 文档

- 部署验收补上前提：这台机器上要有可用的容器引擎（`docker` 在 PATH、守护进程在跑）。
  Docker Desktop、Podman、colima、原生 Linux 引擎都可以。

### 兼容性

- 兼容窗口扩到六个 DSH 版本，新增 `0.2.1-rc.1` 与 `0.2.1-rc.2`。

## 1.3.0 — 2026-10-16

本次收录自 1.2.1 起的全部改动。这里只写使用者与 Agent 能观察到的变化；它是怎么做成的不在这里。

### 破坏性变更

- **工具改名 `wts_worktree_space`**（原 `task_worktree_space`），并新增 8 个 `wts_session_tool_*` 会话工具。
- **`done` 的 `merge` 改为必填。** 不传布尔值直接拒绝（E7006）——合并是两个方向代价都不对称的一步。
- **收尾的未跟踪内容参数换成 `strays`**：`archive`（默认）、`keep`、`discard`；要保留的条目名改由 `keepEntries` 传。工具侧不接受 `discard`（E7007）。
  **默认行为也变了**：`archive` 会把任务空间从磁盘上删掉，而 1.2.1 的缺省是留在原地。
- **插件自己的文件收进 `.worktree-space/`**：记录、说明、部署根都在这里面。旧位置不再被读取。
- **随包 skill 改名** `task-worktree-space` → `worktree-space`。

### 新增

- **部署与验收整条链。** 创建时可声明 `deployTarget: docker`，把工作区的 `.worktree-space/deploy/` 整份复制进任务空间；入口脚本实现 `up`、`smoke`、`destroy`。`up` 写验收地址、`smoke` 写 `lastSmoke`。**验收围栏**：冒烟没记录 `pass` 之前，带 `merge: true` 的 `done` 被拒绝（E5006）。勾了部署却没有可部署的东西时，创建被拒绝（E4015）。
- **8 个会话控制工具**：`find`、`status`、`read`、`send`、`create`、`resume`、`wait`、`cancel`。
- **新的 `dispatch` action**：在已有任务空间里开会话并把活交给它，可指名写入权限与是否盯住它。
- **任务空间可登记为 DSH Workspace**：`registerWorkspace`（默认登记）、`unregisterWorkspace`（默认随收尾撤销）。
- **任务记录在源码根下再留一份**：`<源码根>/.worktree-space/tasks/<项目>/<任务>.json`，归档写进 `tasks-archive/`。

## 1.2.1 — 2026-10-06

### 新增

- 管理页导航列底部加**「插件设置」**入口，直达宿主插件页里本插件的配置。
- 整页面板标题下补上**「使用反馈」**链接，此前只有对话框有。
- 标题下的描述加第二行**使用流程**：选择工作区 → 创建任务空间 → Agent 处理工作 → 结束任务。

### 修复

- README 里管理页面一节的描述与实际不符：视图切换早已在共用导航列里，不在工具栏。

## 1.2.0 — 2026-10-04

### 新增

- **「添加仓库」按扫描结果判定。** 一个仓库该不该被添加，看扫描列表里有没有它，而不是看它的上级目录是不是已注册的工作区。
- 行上的**名字与路径可以选中复制**：箭头是控件，文字不再放在按钮里。
- **默认扫描深度两层 → 三层**，注册在更深布局上的工作区不再读起来像个空目录。
- 工作区下面一层的仓库可以创建任务空间了；任务空间改为**按位置查找**，不再按字符串比较。

### 修复

- **detached HEAD 上的任务提交曾被静默丢弃**：`rev-parse --abbrev-ref HEAD` 返回字面量 `HEAD`，合并成了目标分支合并自己，报成功而提交成了悬空对象。现在明确拒绝。
- 创建失败后的回滚**会留下分支**，同名重试撞上「分支已存在」。
- 同一个创建错误，**审计记录与调用方看到的错误码不一致**（一边 `E2005`，一边塌缩成 `E9001`）。
- `E7007` 不在错误码表里，公开时被压成 `E9001`。
- 勾了「保存为默认」且表单抛异常时，**会把刚建好的任务空间整个删掉**。
- 两个工作区各有同名仓库时，「添加仓库」的勾选会串。
- 用键盘打开任务菜单，动作会挂到鼠标最近用过的那一行上。

## 1.1.0 — 2026-10-01

### 功能

- **建任务空间**：选源码根、起任务名、选分支前缀（默认 `task/`）、勾选跨仓库、指定位置。每个仓库各得一份 `<分支前缀><任务名>` 的 worktree。
- **任务空间登记为工作区**，名字是 `<上级>/<任务名>`，同时开一个会话，工作目录就是这个任务空间。
- **管理页面三个视图**：工作区、Git 仓库、任务空间；都能搜索、按「待处理」筛选、单独或整体折叠。
- **结束任务**：合并回各仓库目标分支、删 worktree、归档文档、注销工作区；仍有会话在跑时先拒绝。
- **任务菜单**（工作区行上的 `⋯`）：新建任务空间、结束任务空间。
- **布局**：任务空间在容器根下，先按项目分层（项目名即源工作区目录名），再是任务，任务下才是各仓库 worktree；归档按 `<项目>/<任务名>-<时间戳>/`。
- **无额外服务依赖**：扫描深度、目录上限由插件自身配置控制；支持 DSH 主题与语言设置。

### 变更

- 管理页默认打开**工作区视图**（原为任务空间，那是唯一开不了任务的视图）。
- 插件存放任务空间的专用目录定名**「Worktree Space 容器 / 容器根」**，「合并回当前分支」统一改为「合并回目标分支」。
- 三个视图各带一句说明，放在控件下方。

### 兼容性

- DSH 兼容范围 `>=0.1.7-rc.1 <0.3.0-0`；可用端为网页端与桌面端。

---

<a id="english"></a>

# Changelog

**English** · [简体中文](#chinese)

What changed in each release. Earlier versions live in the git history only; the per-release
evidence for host compatibility is in [`store-evidence.md`](store-evidence.md).
The Chinese version is [the first half of this file](#chinese).

## 1.3.6 — 2026-10-25

A workspace's context menu can open its directory in the file manager or an editor, and the two
places that named a directory now offer a chooser instead.

### Added

- **The workspace context menu gains "Show in file manager" and "Open in app".** The second is a
  submenu listing what this machine has — IntelliJ IDEA, GoLand, PyCharm, VS Code and so on — and
  picking one opens the workspace directory there. The list comes from the system's own registry,
  so an application installed somewhere other than the default is found too.

  The host runs both, rather than the plugin starting a program itself: a plugin process runs
  inside the host's confinement boundary, and a file manager hands its request to the running
  system shell and exits — so the window was torn down before it appeared. That is exactly the
  first version's "nothing happens, and nothing is reported".

- **Adding a workspace or a repository chooses a directory.** Both used to take a typed path; they
  now have a Browse button that opens the host's own directory chooser, the same one it uses
  elsewhere. The chosen path fills the field, and cancelling changes nothing. Where the host
  offers no chooser, the field still accepts a typed path, so nothing is lost.

### Fixed

- **How the submenu opens.** It opened on a click at first, but the host closes its own menu when a
  menu item is clicked — so pressing the parent left the submenu standing with its menu gone, and
  the user had to answer it before they could get back. It opens on hover now.

- **Whether the submenu survives.** It was mounted on the page root, so moving onto it counted as
  leaving the menu and both closed. It is mounted inside the menu now (same place on screen), so
  reaching for it is no longer a departure.

- **The submenu's background.** It was read from an element that is usually transparent, so the
  submenu showed what was behind it; the colour now comes from the layer that actually paints one,
  which is what the menu beside it uses.

- **A hover hint that occasionally stayed.** The bubble takes no pointer events, so "the pointer
  left" is not enough on its own: an anchor that is re-rendered or removed never fires one. Moving
  the pointer away, pressing anywhere, the window losing focus, or the anchor leaving the document
  all take it down now.

## 1.3.5 — 2026-10-24

The finish dialog opens faster, and a tool result says what to do next.

### Added

- **A result now says what the next call should be.** A tool description is read once, at the
  start, and an agent that has already decided the work is quicker to do itself does not go back
  to it. Four points now restate the default flow in the answer itself — the work belongs to a
  session in the task space, not to this conversation, and it is implemented here only when the
  user explicitly asked for that:
  - a `create` **with no `prompt`**: the space exists with no session on it, and the answer
    carries a `dispatch` call that can be copied as written;
  - `suggest-root`: the next call should be one `create` with a `prompt`;
  - `add` with no session recorded, and `list` where no task has one: the same thing about the
    worktree nobody is on.

  A `create` given a `prompt`, a `dispatch` and a `done` add nothing — those already are what the
  guidance is trying to reach.

### Changed

- **The finish dialog loads faster.** Each repository's git questions used to run in one serial
  loop, and on Windows a `git.exe` launch is almost entirely process creation — a
  three-repository task paid for twenty-one of them end to end. The repositories are now asked
  concurrently (within one repository the calls stay in order, because each depends on the
  previous answer), and one `rev-parse` that was asked twice for the same repository is gone.
  Measured against four synthetic repositories: about 700ms down to 206ms.

- **`done` is faster too.** The read-only probes a finish makes per repository — the branch, the
  source repository, whether a merge is standing, whether work is uncommitted — now run
  concurrently. The actions that follow (merge, remove, delete a branch) stay serial, because one
  repository's failure must not change another's. Measured against synthetic repositories: three
  of them went from 722ms to 333ms, and five from 1179ms to 434ms.

- **`resolveMergeTarget` takes an optional fifth parameter** for the branch the caller has
  already read, which saves a duplicate query. Omitting it still asks git, so existing callers
  are unaffected.

## 1.3.4 — 2026-10-22

The ability to wait on a session is gone.

### Changed

- **`wts_session_tool` has no `wait` action, and `send` and `create` no longer take
  `waitForReply`.** A leader that blocks on a session can neither take the user's next
  instruction nor act on the report that arrives while it waits — and a dispatched session
  reports its own progress, while a turn that ends badly is pushed to the dispatcher by the
  watcher. There was nothing for the wait to do.

  `timeoutMs` and `requireTurnEnd` go with them: they existed only to bound a block.

  The non-blocking half covers the same ground. `status` tells "stuck" from "busy" off the
  session's own clock, `read` shows what it has actually said, and `send` steers it.
  `read` keeps `sinceSeq`, which is a paging cursor there and was never only a wait
  argument.

  **This is a breaking change for a caller**: one still passing `waitForReply`, or calling
  `wait`, gets an argument-validation error. Send, then look once with `status` / `read`
  when you have a reason to — do not block.

## 1.3.3 — 2026-10-21

Nine tools become two, the skill splits into stages that load on demand, and a routine deploy no
longer needs the skill at all.

### Changed

- **The eight session-control tools are now one.** `wts_session_tool_find` / `_status` / `_read` /
  `_send` / `_create` / `_resume` / `_wait` / `_cancel` are eight actions of
  `wts_session_tool`, chosen by an `action` argument. What each of the eight descriptions repeated
  — where a session id comes from, which actions need a live session, what a `sinceSeq` is for —
  is now stated once, and none of the eight capabilities is gone.

  Three argument names changed so that no word means two things: `find`'s `title` / `cwd` /
  `limit` became `titleMatch` / `cwdMatch` / `resultLimit`. They carry a different meaning from
  `create`'s `title` and `cwd` and `read`'s `limit`, and one tool holding both spellings would
  leave the caller guessing.

### Added

- **The skill loads by stage.** `SKILL.md` is a routing table now, and the body is split across six
  files under `references/` — creating, working, finishing, conflicts, deploying, failures — read
  when you reach that stage rather than all at once. A session that only needs a task space and a
  dispatched job no longer reads a whole skill first.

- **A routine deploy needs no skill.** The task's own `.worktree-space/worktree-space.md` already
  names its deploy entry, its `DEPLOY_ENV_ID` and the state file the gate reads, and the tool
  description now points at it. A task whose deploy script is written and has run before is
  deployed by copying those commands — **`references/deploying.md` is for writing or fixing an
  entry, not for running one that already works.**

- **A dispatched session reports before it starts work.** Before writing any code, it says what it
  takes the job to be and which repositories and files it expects to touch. An aim that was
  misread costs one message there, and a finished change nobody asked for at the end.

### Fixed

- The packaging allowlist was missing the six new `references/` files. They were already shipping
  (`files` declares the whole `assets/` directory), but that list is the guard against unrelated
  files riding along, and an unlisted path is a hole rather than a redundant entry.

## 1.3.2 — 2026-10-20

An adjustable wait for the two deploy-for-acceptance steps, and the host compatibility window
narrowed to 0.2.0.

### Added

- **A deploy entry can set its own wait.** The plugin waited ten minutes for `up` and five for
  `smoke` and stopped the script past that, with nowhere to change either. A task whose smoke
  genuinely needed longer had to shorten the smoke or edit the plugin. An entry may now answer a
  third subcommand, `timeouts`, printing one line of JSON with two second counts:
  `{"upSeconds":1200,"smokeSeconds":900}`. The plugin asks once before each step and runs that
  step under the number it printed; either key may be omitted and keeps its default.

  The subcommand may be left out forever. An entry that does not implement it, exits non-zero,
  prints something that is not JSON, or names a value outside 1–3600 seconds is read as having no
  opinion, and the built-in deadlines stand — **it changes how long the plugin waits, never
  whether the step runs**.

### Compatibility

- **The 0.1.7 line is no longer supported.** The lower bound moves from `0.1.7-rc.1` to
  `0.2.0-rc.1` across all four declarations (`engines.dsh`, both peer dependencies —
  `dsh-client-connection` and `dsh-tools` — and `dsh.compatibility.dsh`), and the verified window
  becomes four releases. A host still on 0.1.7 should stay on 1.3.1.

### Documentation

- The Chinese README now links the plugin's Bilibili introduction.

## 1.3.1 — 2026-10-18

Fixes on the Docker deploy-for-acceptance and conflict hand-off paths, plus two documentation
gaps closed.

### Fixed

- **The deploy and smoke buttons no longer report a missing script on Windows.** The `bash` on
  Windows is not a shell and cannot read a native path such as `D:\...`, so an entry that was
  plainly on disk was reported as `No such file or directory`. The plugin now picks a real shell
  itself, and says so plainly when it finds none.
- **The deploy entry cannot find its own tools.** The fix above let the script run for the first
  time, which exposed `dirname: command not found` on the very next line — a shell started by
  absolute path does not get the utilities beside it. The plugin hands those over now.
- **The smoke and destroy buttons disappear.** Containers came up under the deploy entry's own
  default environment id, so the plugin looked for this task's id, found nothing and treated the
  environment as having no containers at all. The `up` and `smoke` commands in a task space's note
  now carry that id.
- **Handing a conflict to an agent adds a Workspace nobody asked for.** The hand-off session was
  opened on the container root, leaving a row in the workspace list named after a directory that
  holds every project's task spaces. It is opened in the task space itself now, and the finish
  that removes the task space drops that row with it.
- **The conflict session does not appear under its task space.** A session opened on a directory
  that is already a Workspace does not join it by itself, so it worked in the right directory and
  still sat in Ungrouped. The plugin now files it there explicitly.

### Documentation

- Deploying for acceptance now states its prerequisite: a container engine this machine can reach
  (`docker` on PATH with its daemon running). Docker Desktop, Podman, colima and a native Linux
  engine all count.

### Compatibility

- The window covers six DSH releases, adding `0.2.1-rc.1` and `0.2.1-rc.2`.

## 1.3.0 — 2026-10-16

Everything that changed since 1.2.1. This is what a user or an agent can observe; how it was
arrived at is not here.

### Breaking changes

- **The tool is renamed `wts_worktree_space`** (was `task_worktree_space`), and eight new
  `wts_session_tool_*` session tools arrive.
- **`done` requires `merge`.** A call without a boolean is refused (E7006) - a merge is the step
  whose two directions cost differently and cannot be undone.
- **The finish's untracked-content parameter becomes `strays`**: `archive` (the default), `keep`,
  `discard`; the entries to keep move to `keepEntries`. The tool refuses `discard` (E7007).
  **The default also changed**: `archive` removes the task space from disk, where 1.2.1's default
  left it standing.
- **The plugin's own files move into `.worktree-space/`**: the record, the note and the deploy root.
  The old locations are no longer read.
- **The bundled skill is renamed** `task-worktree-space` to `worktree-space`.

### Added

- **Deploying for acceptance, end to end.** A create may state `deployTarget: docker`, which copies
  the workspace's `.worktree-space/deploy/` into the task space; the entry implements `up`, `smoke`
  and `destroy`. `up` writes the acceptance URL, `smoke` writes `lastSmoke`. **The gate**: until a
  smoke records `pass`, `done` with `merge: true` is refused (E5006). A create that asks to deploy
  with nothing to deploy with is refused (E4015).
- **Eight session-control tools**: `find`, `status`, `read`, `send`, `create`, `resume`, `wait`,
  `cancel`.
- **A new `dispatch` action** hands a job to a session in a task space that already exists, with a
  permission and a watch flag it may name.
- **A task space can be registered as a DSH Workspace**: `registerWorkspace` (on by default) and
  `unregisterWorkspace` (undone with the finish by default).
- **The task record is also kept under the source root**:
  `<source root>/.worktree-space/tasks/<project>/<task>.json`, with archive in `tasks-archive/`.

## 1.2.1 — 2026-10-06

### Added

- A **plugin settings** entry at the foot of the management page's nav column, opening this
  plugin's own configuration page.
- A **feedback** link under the full-page panel's heading; only the dialog had one.
- A second line under the heading, **the flow**: pick a workspace, create the task space, let the
  agent work, finish the task.

### Fixed

- The management page section of the README described something that was no longer true: the view
  switch has been in the shared nav column, not the toolbar.

## 1.2.0 — 2026-10-04

### Added

- **"Add repository" decides off the scan.** Whether a repository may be added is whether the scan
  lists it, not whether one of its parents is a registered Workspace.
- **Names and paths on a row can be selected and copied**: the arrow is the control, the text is no
  longer inside a button.
- **The default scan depth goes from two levels to three**, so a workspace registered over a deeper
  layout no longer reads like an empty directory.
- Repositories one level below a workspace can create a task space, and a task space is **found by
  location** rather than compared as a string.

### Fixed

- **A task's commits on a detached HEAD were silently dropped**: `rev-parse --abbrev-ref HEAD`
  answers the literal `HEAD`, so the merge became the target branch merging itself - reported as
  success, with the commits left dangling. It is refused now.
- **A failed create's rollback left its branch behind**, so a retry of the same name met "branch
  already exists".
- **One create error reached the audit log and the caller with different codes** (E2005 against a
  collapsed E9001).
- `E7007` was missing from the code table and was published as `E9001`.
- A create that ticked **"save as default"** and then threw **deleted the task space it had just
  made**.
- Two workspaces with a repository of the same name **crossed their "add repository" checkboxes**.
- Opening a row's menu from the keyboard **attached the action to whichever row the pointer had
  last used**.

## 1.1.0 — 2026-10-01

### Features

- **Create a task space**: pick a source root, name the task, choose a branch prefix (`task/` by
  default), tick the repositories to span, choose where it goes. Each repository gets a worktree on
  `<prefix><task>`.
- **The task space is registered as a Workspace** named `<parent>/<task>`, with a session opened on
  it whose working directory is that task space.
- **A management page with three views** - workspaces, Git repositories, task spaces - each
  searchable, filterable by what needs attention, and collapsible row by row or all at once.
- **Finish a task**: merge each repository into its target branch, remove the worktrees, archive the
  documents, unregister the Workspace; refused while a session is still running in it.
- **A task-space menu** on each workspace row: create a task space, finish one.
- **The layout**: task spaces live under the container root, filed by project (the source
  workspace's own directory name) and then by task, with each repository's worktree under that.
  Archive goes to `<project>/<task>-<timestamp>/`.
- **No extra service dependencies**: scan depth and the directory limit are this plugin's own
  settings; DSH themes and language settings are honoured.

### Changed

- The management page opens on the **workspaces view** (it opened on task spaces, the one view from
  which a task cannot be started).
- The directory that holds task spaces is named the **Worktree Space container**, and "merge back
  into the current branch" becomes "merge back into the target branch".
- Each of the three views carries one sentence saying what it lists, below the control it describes.

### Compatibility

- DSH `>=0.1.7-rc.1 <0.3.0-0`; available as both the web and desktop profiles.
