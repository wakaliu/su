# su 用户手册

面向最终用户的快速上手指南：配置中转、添加模型、使用内置 AI。

---

## 1. 五分钟上手

1. **设置 API Key**  
   菜单 **帮助 → Su → 设置 API Key**，或命令面板运行 `Su: 设置 API Key`。  
   密钥只保存在本机 SecretStorage，**不会**写入 `settings.json`。

2. **配置中转 Base URL**  
   命令面板运行 `Su: AI 配置（中转/模型）`，填写 **Su › Base Url**。  
   需为 OpenAI 兼容地址，一般以 `/v1` 结尾，例如：  
   `https://api.openai.com/v1` 或你的中转商提供的 `https://你的中转/v1`。

3. **设置默认模型**  
   在同一设置页填写 **Su › Model**（只填一个，作为 Auto / Ghost Text 默认），例如 `gpt-4o-mini`、`glm-4`。

4. **打开 Chat**  
   按 `Ctrl+L`（macOS：`Cmd+L`），或点状态栏 **Su Chat**。面板在**右侧**辅助栏。

5. **发第一条消息**  
   输入问题后回车发送。若未配置 Key，面板会提示你去设置。

---

## 2. 配置中转服务器

| 设置项 | 含义 |
|--------|------|
| `Su › Base Url` | OpenAI 兼容 API 根地址（含 `/v1`） |
| `Su › Timeout Ms` | 请求超时（毫秒），默认 60000 |
| API Key | 用命令 `Su: 设置 API Key`，不要用明文 settings |

常见问题：

- **401**：Key 错误或未设置 → 重新 `Su: 设置 API Key`。
- **404**：Base URL 缺 `/v1`，或不支持 `chat/completions`。
- **超时 / 网络错误**：检查中转是否可达，或加大 `Timeout Ms`。

清除密钥：命令 `Su: 清除 API Key`。

---

## 3. 配置多个模型

su 使用**同一套** Base URL + API Key，可配置多个模型 id：

| 设置项 | 含义 |
|--------|------|
| `Su › Model` | **默认模型**（Chat 选 Auto、以及 Ghost Text 使用） |
| `Su › Models` | **额外模型列表**（可多个）。点 Add Item 逐个添加 |

更方便的方式：

- 命令面板 / 帮助菜单：**Su: 编辑模型列表**
- Chat 顶栏 **⋯** → **模型列表**

在 Chat **输入区旁**的下拉里可选：

- **Auto (默认模型名)** → 使用 `Su › Model`
- 或列表中任一模型 id → 本次对话 / Agent 使用该模型

---

## 4. IDE Window 与 Agent Window

- **IDE Window**（默认）：中间写代码，右侧 **Su Chat**。
- **Agent Window**：独立 OS 窗口（类似 ChatGPT / DeepSeek 桌面窗，**不是** IDE 里再开一个标签）。命令 `Su: 打开 Agent Window（独立窗口）`，或 Chat 顶栏 **Agent ↗**、状态栏同名按钮。
- 在 Agent Window 顶栏点 **IDE ↗**（或命令 `Su: 打开 IDE Window`）关闭独立窗并回到经典布局。
- 两种窗口**共用同一会话与同一工作区**；不是微软 Pitch your idea / Sessions 壳。
- **换项目 / 空聊天**：顶栏 **+** = 新会话（可空聊）。⋯ 菜单 **打开文件夹（新窗口）** 另开一套 su+项目；**打开文件夹（当前窗口）** 替换本窗工作区。无文件夹时也可先闲聊，再绑定项目。

## 5. 使用 Chat（问答）

1. `Ctrl+L` 打开右侧 **Su AI / Chat**。
2. 底部 **Ask / Plan / Agent** pill：
   - **Ask**：问答与只读浏览（目录/README/打开文件/git；`list_dir` / `read_file`）。单轮最多 `su.ask.maxSteps`（默认 100）。
   - **Plan**：只读探查并讨论需求；清晰后产出可编辑 **执行计划** 卡片。点 **Build** 才切到 Agent 按计划执行；未 Build 不会改代码。
   - **Agent**：改文件 / 跑终端（`Ctrl+I`）。默认不限制工具步数（`su.agent.maxSteps=0`；可用 Esc 停止）。
   助手答复支持醒目标题、Markdown 表格，以及分区图标（如 🔬🗺️⚠️▶️）。
3. 需要时点 **选区** chip，把编辑器选中代码一并发送；输入 `@` 可选文件/选区。
4. Enter 发送，Shift+Enter 换行；生成中可点 **停止** 或按 `Esc`。
5. 顶栏 **`+`** 新对话；**◷** 历史；**⋯** 含 Key / 中转 / 手册；**Agent ↗** 开 Agent Window。
6. 助手代码块可 **复制** 或 **应用到当前文件**。
7. 可往输入区 **拖入图片 / 文件 / 文件夹**（出现 chip，可移除；悬停看路径），或点 **📎** / **当前文件**。  
   - 从 **Windows 资源管理器**拖入：直接松手即可。  
   - 从 **左侧资源管理器 / 顶部标签**：请 **按住 Shift 再松手**，或 **右键 → 添加到 Su Chat**。  
   - **点击图片**可放大预览（灯箱）；再点空白或按 **Esc** 关闭。  
   输入 `/` 可选 Skill。工作区 `.su/rules/` 下的 markdown 会自动注入（可用设置 `Su › Rules: Enabled` 关闭）。识图需视觉模型（如 `glm-4v`）。
8. 要**跑终端 / 改文件**：pill 切到 **Agent**（`Ctrl+I`），或先用 **Plan** 出计划再 **Build**。终端授权只出现在 **Chat 对话区卡片**（允许一次 / 本会话总是允许 / 拒绝）。底部进度会提示「等待你授权」；约 5 分钟未点自动跳过；新对话清除「总是允许」。
9. Agent / Plan 执行中可见 **处理过程** 进度（进行中会展开步骤）；结束后可点摘要折叠。正文结论始终展开。
10. 偶尔会出 **需要你的选择 / 建议确认** 卡片（可多选 + 补充说明）：**发送**后按你的选择继续；**关闭**时——抉择类继续当前方案不扩展，建议类（按钮「关闭并结束」）结束任务且不替你执行。Esc/停止 是取消生成，不会当成「关闭建议」。
11. Agent 一开始就会显示 **处理过程 · 正在思考**；有工具调用时展开具体步骤。
12. Agent / Plan 单轮调模型默认最长 **10 分钟**（设置 `su.agent.timeoutMs`）；Ask 用 `su.timeoutMs`。超时不是整次任务总时长，而是「这一轮等模型」的上限。

---

## 6. 使用 Plan（先规划再执行）

1. 底部 pill 选 **Plan**，用自然语言描述目标（可先讨论范围与验收标准）。
2. 模型只读浏览工作区；需求不清时会先提问；足够清晰后出现 **执行计划** 卡片（Markdown，可直接改）。
3. 点 **View**：在工作区写入 `.su/plans/<标题>_<id>.plan.md` 并在编辑区打开（类似 Cursor 的临时计划文档）；保存后会同步回 Chat 计划卡。
4. 确认后点 **Build**：自动切到 **Agent**，并把当前计划（含编辑器未保存缓冲，若仍打开）注入本轮上下文开始执行。Agent 会尽量连续跑完整份计划；若中途提前收尾会自动再催一轮（无需反复输入「继续」）。Keep/Reject 不阻断执行。
5. 未点 Build：不会改业务代码、不会跑终端（View 仅写计划 md）。关闭或停止也不会替你执行。

---

## 7. 使用 Agent（改文件 + Diff）

1. `Ctrl+I` 打开并切到 **Agent**，或底部 pill 选 **Agent**（也可从 Plan 点 Build）。
2. 用自然语言下任务（如「给 README 加一节安装说明」）；也可拖入截图/文件后让 Agent 据图改代码（与 Ask 相同，需视觉模型）。
3. Agent 可在**当前工作区**内列目录、读文件、写文件、替换文本；终端命令默认每次需确认。
4. 写入后：顶栏 Diff 角标、面板待审条（**Keep All / Reject All / 审阅**），状态栏显示 **待审 N**。
5. **Keep** 保留改动，**Reject** 恢复修改前（新建文件则删除）。

相关设置：

- `Su › Agent: Max Steps`：单轮最大工具步数（`0`=不限制，默认）  
- `Su › Ask: Max Steps`：Ask 只读工具步数（默认 100）  

- `Su › Agent: Enable Terminal`：是否允许 `run_terminal`（仍需确认）

---

## 8. Ghost Text（行内补全）

- 编辑代码时，灰色预览建议补全；**Tab** 接受（与编辑器默认一致）。
- 开关：命令 `Su: 切换 Ghost Text`，或设置 `Su › Ghost Text: Enabled`。
- Ghost Text **始终使用默认模型** `Su › Model`（不受 Chat 下拉影响）。

---

## 9. 编辑区字体大小

中间代码/文件编辑区字号**已有**上游设置，无需另做功能：

| 方式 | 操作 |
|------|------|
| 只调编辑器字号 | `Ctrl+,` 打开设置 → 搜 **Font Size** → **Editor: Font Size**（产品默认 **16**） |
| 快捷键整界面缩放 | `Ctrl+=` 放大、`Ctrl+-` 缩小、`Ctrl+0` 重置（影响侧栏/菜单等整窗） |
| 命令面板 | `Ctrl+Shift+P` → 输入 `Zoom In` / `Zoom Out` / `Reset Zoom` |
| 鼠标（可选） | 设置打开 **Editor: Mouse Wheel Zoom** 后，按住 `Ctrl` 滚轮只缩编辑区 |

工作区可写 `.vscode/settings.json`：`"editor.fontSize": 16`。

---

## 10. 检查更新

- 菜单 **帮助 → Su → 检查更新**，或命令 `Su: 检查更新`。
- 更新源为 GitHub Releases（默认仓库可在 `Su › Update: Repo` 修改）。
- 若要接收开发预览版，打开 `Su › Update: Include Prerelease`。

---

## 11. 常用命令速查

| 命令 | 作用 |
|------|------|
| `Su: 打开 Chat` | 打开右侧 AI 面板（`Ctrl+L`） |
| `Su: 打开 Agent Window（独立窗口）` | 弹出独立 OS 对话窗 |
| `Su: 打开 IDE Window` | 回到经典编辑器 + 侧栏 Chat |
| `Su: 打开文件夹（新窗口）` | 另开 su 窗口绑定新项目 |
| `Su: 打开文件夹（当前窗口）` | 替换本窗工作区 |
| `Su: 打开 Agent` | 打开面板并切 Agent 模式（`Ctrl+I`） |
| `Su: 停止生成` | 停止流式输出（`Esc`，生成中） |
| `Su: 设置 API Key` | 保存密钥到本机 |
| `Su: AI 配置（中转/模型）` | 打开 Base URL / Models 设置 |
| `Su: 编辑模型列表` | 增删可选模型 |
| `Su: 切换 Ghost Text` | 开关行内补全 |
| `Su: 审阅 Agent 改动` | Keep / Reject |
| `Su: 检查更新` | 查 GitHub Releases |
| `Su: 用户手册` | 打开本文 |

---

## 12. 隐私说明

- API Key **仅本机** SecretStorage，不随工程提交。
- 对话内容会发往你配置的 Base URL（中转 / 模型服务商），请使用可信中转。
- 不要把 Key 贴进 Chat 或提交到 Git。
