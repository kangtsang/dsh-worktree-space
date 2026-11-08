<a id="chinese"></a>

# 更新日志

**简体中文** · [English](#english)

记录每个版本的改动。更早的版本只留在 git 历史里；宿主兼容性的逐版本实测证据在
[`store-evidence.md`](store-evidence.md)。英文版见[本文档英文部分](#english)。

## 1.4.1 — 2026-11-08

任务是插件自动开的会话时，侧栏标题直接说明它属于哪个任务空间；结束任务的对话框改用与任务空间视图同一套数字，并且多个仓库时打开更快。只把任务空间注册成工作区，任务也能被发现了。

### 新增

- **会话标题由插件自己写。** 派单、交由 agent 提交、交由 agent 解决冲突这三种自动开的会话，标题统一以
  `【WTS Dispatch】`、`【WTS Commit】`、`【WTS Conflict】` 开头，后面接 `<项目>/<完整分支名>`，
  例：`【WTS Dispatch】mall-project/task/coupon`。以前标题由宿主从首条消息的前五个词截取，派单会话于是
  显示成 `# Standing instructions (added by` 这类看不出属于哪个任务的名字。标题以插件写入为准，之后
  的对话不会把它改掉。
- **结束任务对话框改用与任务空间视图同一套数字。** 每个仓库显示**领先/落后目标分支**的提交数
  （`↑` / `↓`）、**已提交变更**与**未提交变更**各自的增删行数，与任务空间视图里的口径一致。换目标分支后
  这些数字立刻按新目标重算 —— 「落后」尤其有意义：它说的是任务进行期间目标分支又前进了多少。
- **对话框的汇总拆成两行。** 第一行是任务空间目录，第二行是变更数据。以前目录与数字挤在一行，路径一长
  就把数字挤到不确定的位置。
- **只注册任务空间也能发现任务。** 任务的 worktree 由源仓库报出，所以源仓库不在任何工作区里时，任务本来
  查不到 —— 它只出现在工作区列表，任务空间视图里没有。现在插件读任务记录里记下的源仓库，用它把任务找出来。
  只列出属于这个任务空间的 worktree：同一源仓库下没在工作区里的其它任务不会跟着露出来。把源仓库本身
  注册成工作区时，它下面所有 worktree（含其它任务）照常全部列出。

### 变更

- **任务空间视图与工作区视图的合计合并成一对行数。** 以前头部只统计已提交的增删行，仓库行里却同时有
  已提交与未提交两对，于是任务带着一堆没提交的改动时，头部只报了其中一半。现在合计把两者相加，悬停提示
  写明「已提交与未提交合计」。结束任务对话框仍分开显示两对。
- **未提交改动为空时，汇总写「无未提交变更」**，而不是留一个没有数字的标签。

### 修复

- **多个仓库时结束任务对话框打开慢。** 打开对话框要问每个仓库几条 git 命令，而这些命令原本串行执行。
  在 Windows 上 `git.exe` 的启动几乎全是进程创建开销，所以这段等待随仓库数线性增长。现在互相独立的调用
  并行执行，并且去掉了一次多余的 `git rev-parse` —— 源仓库当前检出的分支本来就在 `git worktree list` 的
  输出里。单个仓库实测从 1219 ms 降到 712 ms。

## 1.4.0 — 2026-11-07

任务空间与源码仓库都显示领先、落后的提交数与增删行数。源码仓库与自己的远端跟踪分支相比，任务空间里的仓库与源仓库当前检出的分支相比；前者不等拉取完成，先显示本地引用，远端在后台刷新。

### 新增

- **仓库与远端跟踪分支的比较。** 工作区视图里每个源码仓库显示 `远端分支：<分支>`、领先与落后的提交数
  （`↑` / `↓`），以及这些提交新增与删除的行数。工作区头部显示它下面所有仓库的合计。
  比较的对象是该分支配置的 upstream，不是另一个本地分支。
- **任务空间按层显示：合计在头部，明细在每个仓库。** 任务空间头部显示**任务分支**与整个任务的领先、
  落后提交数及增删行数合计；展开后，每个仓库那一行显示它的**基线分支**与这个仓库自己的一份数字。
  基线分支是源仓库当前检出的分支，也就是收尾会合并进去的那一个。
- **已提交与未提交分开计。** 「已提交变更」是相对基线已经提交的那部分改动，「未提交变更」是工作区里
  还没提交的部分。两者都用绿色记新增、红色记删除。
- **两项配置：自动拉取远端分支、拉取超时。** 自动拉取默认开启，打开页面时在后台对每个源码仓库执行
  `git fetch --quiet --no-tags`；超时默认 8 秒，按仓库各自计时，一个仓库超时不影响其它仓库。
  fetch 只更新远端跟踪引用，不改动工作区与本地分支。关闭自动拉取后只与本地已有的引用比较。
  打开页面时先按本地已有的引用把数字显示出来，不等拉取；拉取真的带回新提交才更新。拉取失败与主动
  关闭分开标注：失败标橙色「拉取失败」（悬停给出原因），关闭标灰色「未拉取」。

### 变更

- **结束任务对话框里的提交数与变更状态回到分支那一行**，跟在 `任务分支 → 目标分支` 后面；
  「源仓库」那一行只留路径。
- **管理页说明里增加「视频介绍」链接**，指向 B 站的插件介绍，只在中文界面显示。
- **添加工作区与添加仓库的输入框恢复手工填写**，「浏览…」只是另一种选择目录的方式，回车即可提交。
- **兼容下界提高到 `0.2.1-rc.1`。** 四处声明（`engines.dsh`、两个 peer 依赖、`dsh.compatibility.dsh`）
  一起从 `>=0.2.0-rc.1` 收窄到 `>=0.2.1-rc.1`，上界不变。**`0.2.0-rc.1` 与 `0.2.0-rc.2` 上的安装从此被
  拒绝**——DSH 会强制校验 peer 范围，拒绝发生在安装前或启动时，并给出 `dsh plugin allow-version` 的
  豁免命令。还在这两个版本上的使用者需要先升级 DSH。
- **兼容窗口移到最新的五个 DSH 版本**：`0.2.1-rc.2`、`0.2.1-rc.3`、`0.2.1-rc.4`、`0.2.1-rc.5`、`0.2.2-rc.1`。

### 修复

- **目标分支在预演之后又被推进时，冲突报不出来。** 收尾先把目标分支合进任务分支预演一次，正式合并
  再合回源仓库；两条命令之间目标分支若多了新提交，正式合并就会在没人预演过的改动上冲突。Git 会中止
  那次合并，于是任何地方都没留下冲突，面板只报一个普通失败，没有东西可以交给 agent——使用者得再收尾
  一次，第二次才报出第一次就该报的冲突。现在这种情况会在任务 worktree 里重合一次，把冲突留在那里；
  使用者的检出不被碰触，属于使用者未提交改动的失败仍按原样报告。

### 移除

- **工作区菜单里的「在文件管理器中打开」。** 宿主自己就有「在文件夹显示」，两条做的是同一件事。
- **插件详情页的更新胶囊。** 更新提示保留在插件自己的界面（管理页与侧边栏面板）里。

## 1.3.10 — 2026-11-03

每个仓库可以有自己的起点分支，创建对话框里逐仓库选择；模型不可达时派单直接失败，不再留下一个跑不起来的会话。

### 新增

- **按仓库指定起点。** `wts_worktree_space` 的 `create` 与 `add` 增加 `baseRefs` 参数：一个「仓库名 →
  ref」的映射。每个仓库的起点按 **`baseRefs[仓库名]` → `baseRef` → 该仓库当前 HEAD** 求值，所以
  「大部分仓库从 `develop` 起、只有某个从 `main` 起」只需写出例外的那一个。`baseRefs` 点名了本次没选中的
  仓库会被拒绝（`E4019`），拼错的名字不会静默失效。
- **创建对话框可以逐个仓库选起点。** 每张仓库卡片上有 **指定分支**，点开是这个仓库的分支列表（可搜索，
  最多 100 条，超出时说明还剩多少条）。它只给这一个仓库的 worktree 定起点，**不是 checkout**。
- **默认起点改为从共有分支里选。** 「分支起点」从「单选 + 手填 ref」变成一个下拉，列出**所有已勾选仓库
  共有**的分支——一次创建给每个 worktree 同一个起点，某个仓库没有的分支不能作为共同起点。取消勾选仓库后，
  所选分支若不再共有会作废、不带进创建。列表只列**本地分支**。
- **`create` / `dispatch` 增加 `agentPreset`**，指定任务会话由哪个 agent preset 组合而成。
- **`list` / `add` / `done` 返回值的 `sessions` 每项带上 `model` 与 `modelSource`**，可以直接看出某个
  任务会话跑在哪个模型上、这个选择来自哪一层。

### 变更

- **模型不可达时派单直接失败（`E4018`），不再留下一个注定跑不起来的会话。** 校验提到创建任何东西之前：
  宿主**确认不支持**该模型时，任务空间、分支、会话都不会创建；宿主只是**读不出**模型目录时照常派单，
  答复里说明读不出的原因。这两种情形原先共用一句「无法路由」，现在分别给提示。
- **交给 agent 的两个入口常驻显示**，插件配置里的「交由 agent 解决冲突入口」一项已删除。
- **管理页面默认折叠**，三个视图都从折叠状态开始。

### 修复

- **会话的模型会从任务记录里消失。** 读回记录时会重建会话条目，而重建没带上 `model` / `modelSource`；
  会话回报一次就把这两个字段从文件里抹掉，归档后更无从查起。现在两处都透传。

## 1.3.9 — 2026-11-02

派单时可以指定任务会话使用的模型；任务会话的模型出故障、自己恢复不了时，队员可以给它换一个再唤醒继续干。

### 新增

- **派单时指定模型。** `wts_worktree_space` 的 `create` 与 `dispatch` 增加 `model` 参数（形如
  `provider/model`）与可选的 `reasoningEffort`。任务会话用哪个模型按这个顺序决定：**派单时指定的
  `model`** → **插件配置里的「任务会话模型」** → **派单会话当前使用的模型**。前两条都没指定时就是
  默认行为，不需要配置任何东西。

  指定了宿主用不了的模型不会静默退回：会话照常开起、活照常交出去，答复里带一条警告，写明实际可用的模型。

- **插件配置新增「任务会话模型」。** 选项就是宿主当前能用的模型列表，默认「不指定」。读取时先显示
  「正在读取模型列表」而不是空的「不指定」——后者会被读成「这个部署没有模型」；读取失败时给出重试。

- **`wts_session_tool` 新增 `model` 动作。** 不带参数时返回该会话当前的模型与宿主能用的全部模型；
  带上 `provider/model` 就切换，**会话若已离线会先自动唤醒**，所以「换模型 + 继续干」是一次调用。
  换的模型记在会话自己的日志里，重启后仍然有效。

  只有**派出这个任务的会话**能改它。队员之间互相改、或者队员反过来改队长的，都会被拒绝（`E4017`）。

### 变更

- **交给 agent 的两个入口不再是「实验性」。** 结束任务对话框里的提示条、配置项名称里的括注、
  文档里的 Beta 说明一并去掉；配置项改名为「交由 agent 解决冲突入口」。
- **侧边栏面板入口的配置项改名为「插件槽位入口」**，与它实际控制的东西一致。
- **README 新增「快速开始」章节**，用三步走通一次完整任务；章节顺序调整为按使用顺序阅读，
  「插件配置」与「权限与失败边界」移到操作日志之前。


## 1.3.8 — 2026-10-28

任务空间的两个工具改为按会话装载，用不到的会话不再为它们付出常驻开销。

### 变更

- **`wts_worktree_space` 与 `wts_session_tool` 不再在每个会话里常驻。** 两者加起来约 3.6k token，
  而多数会话跟任务空间无关，所以普通会话只看到一个 `load_worktree_space`：第一次要用任务空间时调它
  一次，两个工具就装进这个会话。**任务空间里的会话**（被派单干活的那一个）两个工具一开始就在手上，
  不用多调一次。

  工具自带的说明仍然够用，不读随包 skill 也能完成单件事；skill 补的是描述装不下的那部分——先做什么
  后做什么、哪些问题要问用户、每种「停下来」是什么意思。

## 1.3.7 — 2026-10-26

有新版本发布时，管理页和插件详情页会提示，并可直接复制安装用的包名。文档同时做了精简。

### 新增

- **有新版本时给出提示。** 管理页标题旁、以及插件管理页里本插件的详情页，会在有新版本时显示一个胶囊，
  写明版本号。列表来自 npm，取不到时静默不提示——网络不通不该变成一条错误。

  两种操作：**左键**打开更新说明，**右键**复制 `dsh-worktree-space@1.3.7` 这样的包名，可以直接粘贴到
  插件管理的安装框里。复制的版本就是胶囊上那个版本，不是「最新」——提示针对的正是这一版。

  版本号在构建时写入包内，不在运行时读取：浏览器读不到 `package.json`。

### 变更

- **README 精简了功能说明。** 搜索、筛选、折叠这类看界面就能知道的操作不再逐一描述，与功能无关的数字
  与自我说明也去掉了。功能条目从 11 条降到 6 条。

## 1.3.6 — 2026-10-25

工作区右键菜单可以直接在文件管理器或编辑器里打开目录，添加工作区与仓库改为选择目录。

### 新增

- **工作区的右键菜单多了「在文件管理器中打开」和「在应用中打开」。** 后者是一个二级菜单，列出这台
  机器上装了什么——IntelliJ IDEA、GoLand、PyCharm、VS Code 之类，点一项就在那个应用里打开这个
  工作区目录。列表来自系统自己的注册信息，所以装在非默认位置的应用也能找到。

  这两项都由宿主执行，不是插件自己去启动程序：插件进程跑在宿主的隔离边界里，而文件管理器把请求
  交给已在运行的系统 shell 就退出了，窗口会在它出现之前被一起收掉——这正是第一版「点了没反应、
  也不报错」的原因。

  二级菜单在悬停时展开、嵌在一级菜单内部，所以移向子菜单不会把它关掉；一级菜单的项被点击时
  宿主会关掉整个菜单，悬停因此也是唯一可行的展开方式。

- **添加工作区、添加仓库改为选择目录。** 原来要手输路径，现在旁边有「浏览…」，打开的是宿主自己的
  目录选择器（和它在别处用的是同一个）。选完路径填进输入框，取消则什么都不改。宿主没有提供选择器
  时，输入框仍可手打，功能不丢。

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

## 1.4.1 — 2026-11-08

A session the plugin opens for you now says in its sidebar title which task space it belongs to; the
finish dialog draws the same figures the task view does, and opens faster when a task spans several
repositories. A task space registered on its own is enough for its task to be found.

### Added

- **The plugin writes the session title.** The three kinds of session it opens on its own — dispatch,
  hand over the commits, hand over the conflicts — start with `【WTS Dispatch】`, `【WTS Commit】` or
  `【WTS Conflict】`, followed by `<project>/<full branch>`, for example
  `【WTS Dispatch】mall-project/task/coupon`. The host used to derive a title from the first five words of
  the first message, which left a dispatched session reading `# Standing instructions (added by` — a name
  that named no task. The title the plugin writes is final: later messages do not overwrite it.
- **The finish dialog draws the same figures the task view draws.** Per repository: commits
  **ahead of and behind the target branch** (`↑` / `↓`), and the lines **committed** and **uncommitted**
  each carry. Changing the target recomputes all of them at once — `behind` is the interesting one, since
  it says how far the target moved while the task was being worked on.
- **The dialog's summary is two lines.** The task space directory on the first, the change figures on the
  second. They shared one line before, so a long path pushed the numbers to wherever the line happened to
  wrap.
- **A task space registered on its own is enough.** A task's worktrees are reported by its source
  repositories, so a task whose source repositories were in no Workspace could not be found — it showed in
  the Workspace list and nowhere in the task view. The recorded source repositories are read instead, and
  the task is listed. Only the worktrees of that task space are reported: another task under the same
  source repository, itself in no Workspace, does not appear with it. Registering the source repository
  itself still lists every worktree it holds, other tasks included.

### Changed

- **The task view's and the Workspace view's totals are one pair of line counts.** The header counted
  committed lines only while the repository rows carried both halves, so a task holding uncommitted work
  reported half of what its own rows were showing. The total now adds both, and the hint says so. The
  finish dialog still shows the two pairs separately.
- **A summary with nothing uncommitted says "no uncommitted changes"** rather than leaving a label with no
  numbers after it.

### Fixed

- **The finish dialog was slow to open on a task spanning several repositories.** Opening it asks each
  repository a handful of git questions, and those ran one after another. On Windows a `git.exe` launch is
  almost entirely process creation, so the wait grew with the repository count. Calls that do not depend
  on each other now run together, and one `git rev-parse` is gone: the branch the source repository sits
  on is already in the `git worktree list` output. Measured on one repository, 1219 ms down to 712 ms.

## 1.4.0 — 2026-11-07

Task spaces and source repositories both show commits ahead, commits behind and lines changed. A source
repository is compared with its own remote-tracking branch, a repository inside a task space with the
branch its source checkout sits on; the former does not wait for the fetch — it shows the local refs at
once and refreshes from the remote in the background.

### Added

- **A repository compared with its remote-tracking branch.** In the Workspace view every source repository
  shows `Remote branch: <branch>`, the commits ahead and behind (`↑` / `↓`), and the lines those commits add
  and remove. The Workspace header carries the sum over its repositories. What it compares against is the
  branch's configured upstream, not another local branch.
- **A task space shows totals on its header and detail on each repository.** The header carries the **task
  branch** with the task's ahead/behind and line totals; opened, each repository row carries its **base
  branch** with that repository's own figures. The base is the branch the source checkout sits on — the one
  a finish would merge into.
- **Committed and uncommitted counted separately.** "Committed changes" is what is already committed against
  the base; "uncommitted changes" is what the working tree still holds. Both read green for added, red for
  removed.
- **Two settings: fetch remotes automatically, and the fetch timeout.** Fetching is on by default and runs
  `git fetch --quiet --no-tags` per source repository in the background when the page opens; the timeout
  defaults to 8 seconds and is timed per repository, so one slow remote does not hold up the others. A fetch
  updates the remote-tracking refs only — never the working tree or a local branch. With it off, the
  comparison uses the refs already on disk. The numbers show from the local refs as soon as the page
  opens, without waiting for the fetch, and move only when the fetch brings new commits. A failed fetch
  and a switched-off fetch read differently: amber "fetch failed" with the reason on hover, grey
  "not fetched" for the reader's own choice.

### Changed

- **The finish dialog's commit counts and change state move back onto the branch line**, after
  `task branch → target branch`; the "Source repository" line keeps the path alone.
- **The management page's description gains a video link** to the plugin introduction on Bilibili, shown
  only in the Chinese interface.
- **The add-Workspace and add-repository fields accept a typed path again.** "Browse…" is one way to name a
  directory, not the only one, and Enter submits.
- **The compatibility floor moves up to `0.2.1-rc.1`.** All four declarations (`engines.dsh`, both peer
  dependencies and `dsh.compatibility.dsh`) narrow from `>=0.2.0-rc.1` to `>=0.2.1-rc.1`; the ceiling is
  unchanged. **Installing on `0.2.0-rc.1` or `0.2.0-rc.2` is now refused** — DSH enforces the peer range,
  so the refusal comes before installation or at startup and names the `dsh plugin allow-version` command
  that exempts it. Anyone still on those two releases has to upgrade DSH first.
- **The compatibility window moves to the newest five DSH releases**: `0.2.1-rc.2`, `0.2.1-rc.3`,
  `0.2.1-rc.4`, `0.2.1-rc.5` and `0.2.2-rc.1`.

### Fixed

- **A target branch that moved after the rehearsal left no conflict to hand on.** A finish rehearses the
  merge first — the target into the task branch — then merges back into the source repository. A commit
  landing on the target between those two commands makes the real merge conflict on work nobody rehearsed;
  Git aborts it, leaving no merge standing anywhere, so the panel got a plain failure with no conflict to
  offer and the user had to finish again — only the second pass raised the conflict the first should have
  reported. That case now merges once more in the task worktree and leaves the conflict there. The user's
  own checkout is never touched by it, and a failure that is the user's uncommitted work is still reported
  as one.

### Removed

- **"Open in file manager" in the Workspace menu.** The host ships its own "Show in folder"; the two did the
  same thing.
- **The update capsule on the Plugins detail page.** The update pill stays in this plugin's own surfaces —
  the management page and the sidebar panel.

## 1.3.10 — 2026-11-03

Each repository can have a start point of its own, chosen per repository in the create dialog; a dispatch
naming a model the host does not serve now fails instead of leaving a session that cannot run.

### Added

- **A start point per repository.** `create` and `add` on `wts_worktree_space` take a `baseRefs` argument:
  a mapping of repository **name** to ref. Each repository's start point is resolved as
  **`baseRefs[name]` → `baseRef` → that repository's own HEAD**, so "everybody from `develop` except that
  one from `main`" only has to name the exception. A name `baseRefs` carries for a repository this call
  does not select is refused (`E4019`) rather than quietly ignored.
- **The create dialog picks a start point per repository.** Each repository card carries **Choose branch**,
  which opens that repository's own branch list — searchable, at most 100 entries, with a note saying how
  many were left out. It sets the start point for that one repository's worktree and is **not a checkout**.
- **The default start point is now chosen from the shared branches.** The field changed from a radio pair
  with a free-text ref into a dropdown listing the branches **every ticked repository carries** — one
  create gives every worktree the same start point, so a branch one of them lacks cannot be the shared one.
  Unticking a repository makes a choice that is no longer shared void rather than sending it. The list holds
  **local branches** only.
- **`create` / `dispatch` take `agentPreset`**, naming the agent preset a task session is composed from.
- **`sessions` in the `list` / `add` / `done` answers now carry `model` and `modelSource`**, so which model
  a task session runs on, and which level chose it, are readable from the answer itself.

### Changed

- **A dispatch naming a model the host does not serve fails (`E4018`) instead of leaving a session that
  cannot run.** The check now happens before anything is created: when the host **knows** it does not serve
  the model, no task space, branch or session is made; when the host merely **cannot read** the catalogue,
  the dispatch goes through and the answer says what could not be read. The two used to share one
  "cannot route" sentence; each now gets its own.
- **The two agent handoff entrances are always shown**; the "agent handoff entry" setting is gone.
- **The management page opens folded**, all three views starting collapsed.

### Fixed

- **A session's model disappeared from the task record.** Reading the record back rebuilt each session
  entry without `model` / `modelSource`, so one report from the session erased both from the file, and a
  finish archived what was left. Both places now carry them through.

## 1.3.9 — 2026-11-02

A dispatch can name the model its task session runs on, and a member whose model fails can
be moved onto another one and woken up to carry on.

### Added

- **A dispatch can name a model.** `create` and `dispatch` on `wts_worktree_space` take a
  `model` argument (`provider/model`) plus an optional `reasoningEffort`. The model a task
  session starts on is decided in this order: **the `model` named on the dispatch** → **the
  "task session model" in the plugin configuration** → **the model the dispatching session
  is using**. With neither of the first two set, that last one is the default and needs no
  configuration at all.

  A model the host cannot route to is not swapped for the inherited one in silence: the
  session is still opened and the work still handed over, and the answer carries a warning
  naming the routes that do exist.

- **A "task session model" row in the plugin configuration.** Its options are the models
  the host can reach right now, and it defaults to "not specified". While the list is being
  read it says "reading the model list" rather than an empty "not specified" — the latter
  reads as "this deployment has no models" — and offers a retry when the read failed.

- **A `model` action on `wts_session_tool`.** With no argument it reports the session's
  current model and every model the host can reach; with `provider/model` it switches,
  **resuming the session first when it is offline**, so switching and continuing is one
  call. The choice is recorded on the session's own log and survives a restart.

  Only the session that dispatched a task may change it. A member moving its leader, or two
  members moving each other, are refused (`E4017`).

### Changed

- **The two entries that hand work to an agent are no longer "experimental".** The notice in
  the finish dialog, the parenthetical in the setting's name and the Beta notes in the docs
  are gone; the setting is now "agent handoff entry".
- **The sidebar panel row's setting is renamed to "plugin slot entry"**, which is what it
  controls.
- **The README gains a "quick start" chapter** walking one complete task in three steps, and
  the chapters are ordered the way they are read: "plugin configuration" and "permissions
  and failure boundaries" now sit before the operation log.


## 1.3.8 — 2026-10-28

The two task-space tools are now mounted per session, so a session that never needs them
no longer pays for them on every request.

### Changed

- **`wts_worktree_space` and `wts_session_tool` are no longer resident in every session.**
  Together they carry about 3.6k tokens, and most sessions have nothing to do with a task
  space, so an ordinary session sees one `load_worktree_space`: call it once when a task
  space is first needed and both tools are mounted into that session. A session **inside a
  task space** - the one a dispatch put there to do the work - starts with both in hand and
  pays nothing extra.

  Each tool still carries enough description to be used on its own, without reading the
  bundled skill; the skill adds what a description cannot hold - the order to do things in,
  which questions to put to the user, and what each stop means.

## 1.3.7 — 2026-10-26

The management page and this plugin's own detail page say when a newer version is
published, and copy the package spec to install it. The documentation is shorter too.

### Added

- **A notice when a newer version exists.** The management page's title row, and this
  plugin's detail page under Plugins, show a capsule naming the version. It comes from
  npm, and stays quiet when it cannot be fetched - a network that is down is not an error
  worth reporting.

  Two actions: **left click** opens the release notes, **right click** copies a spec like
  `dsh-worktree-space@1.3.7` for the Plugins page's install field. The version copied is the
  one the capsule names, not `latest` - that version is what the notice is about.

  The version is stamped into the bundle at build time rather than read at runtime: a
  browser cannot read `package.json`.

### Changed

- **A shorter README.** Searching, filtering and folding are no longer described one by
  one - the interface answers those by being looked at - and numbers that say nothing
  about the feature, along with the plugin's own self-description, are gone. Eleven
  feature bullets become six.

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

  The submenu opens on hover and is mounted inside the menu, so reaching for it does not close
  either — and because the host closes its own menu when an item is clicked, hover is the only
  way it could open at all.


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
