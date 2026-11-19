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
- **Agent Window**：对话为主的大窗口。命令 `Su: 打开 Agent Window`，或 Chat 顶栏 **Agent ↗**、状态栏同名按钮。
- 在 Agent Window 顶栏点 **IDE ↗**（或命令 `Su: 打开 IDE Window`）回到经典布局。
- 两种窗口**共用同一会话**；不是微软 Pitch your idea / Sessions 壳。

## 5. 使用 Chat（问答）

1. `Ctrl+L` 打开右侧 **Su AI / Chat**。
2. 底部 **Ask / Agent** pill 选 **Ask**（自动关联当前打开文件夹：目录/README/打开文件/git 分支；并可只读浏览文件）。Ask 单轮最多 `su.ask.maxSteps` 次 list/read（默认 16）；问「项目介绍」仍超限时可调高或切 Agent。助手答复支持醒目标题与 Markdown 表格（类似 Cursor）。
3. 需要时点 **选区** chip，把编辑器选中代码一并发送；输入 `@` 可选文件/选区。
4. Enter 发送，Shift+Enter 换行；生成中可点 **停止** 或按 `Esc`。
5. 顶栏 **`+`** 新对话；**◷** 历史；**⋯** 含 Key / 中转 / 手册；**Agent ↗** 开 Agent Window。
6. 助手代码块可 **复制** 或 **应用到当前文件**。
7. 可往输入区 **拖入图片 / 文件 / 文件夹**（出现 chip，可移除；悬停看路径），或点 **📎** / **当前文件**。  
   - 从 **Windows 资源管理器**拖入：直接松手即可。  
   - 从 **左侧资源管理器 / 顶部标签**：请 **按住 Shift 再松手**，或 **右键 → 添加到 Su Chat**。  
   输入 `/` 可选 Skill。工作区 `.su/rules/` 下的 markdown 会自动注入（可用设置 `Su › Rules: Enabled` 关闭）。识图需视觉模型（如 `glm-4v`）。
8. 要**跑终端 / 改文件**：pill 切到 **Agent**（`Ctrl+I`）。终端会弹确认窗；只读 git 可「本会话允许同类」。
9. **处理过程**默认折叠，点「处理过程 · N 步」可展开；正文结论始终展开。

---

## 6. 使用 Agent（改文件 + Diff）

1. `Ctrl+I` 打开并切到 **Agent**，或底部 pill 选 **Agent**。
2. 用自然语言下任务（如「给 README 加一节安装说明」）；也可拖入截图/文件后让 Agent 据图改代码（与 Ask 相同，需视觉模型）。
3. Agent 可在**当前工作区**内列目录、读文件、写文件、替换文本；终端命令默认每次需确认。
4. 写入后：顶栏 Diff 角标、面板待审条（**Keep All / Reject All / 审阅**），状态栏显示 **待审 N**。
5. **Keep** 保留改动，**Reject** 恢复修改前（新建文件则删除）。

相关设置：

- `Su › Agent: Max Steps`：单轮最大工具步数  
- `Su › Agent: Enable Terminal`：是否允许 `run_terminal`（仍需确认）

---

## 7. Ghost Text（行内补全）

- 编辑代码时，灰色预览建议补全；**Tab** 接受（与编辑器默认一致）。
- 开关：命令 `Su: 切换 Ghost Text`，或设置 `Su › Ghost Text: Enabled`。
- Ghost Text **始终使用默认模型** `Su › Model`（不受 Chat 下拉影响）。

---

## 8. 编辑区字体大小

中间代码/文件编辑区字号**已有**上游设置，无需另做功能：

| 方式 | 操作 |
|------|------|
| 只调编辑器字号 | `Ctrl+,` 打开设置 → 搜 **Font Size** → **Editor: Font Size**（产品默认 **16**） |
| 快捷键整界面缩放 | `Ctrl+=` 放大、`Ctrl+-` 缩小、`Ctrl+0` 重置（影响侧栏/菜单等整窗） |
| 命令面板 | `Ctrl+Shift+P` → 输入 `Zoom In` / `Zoom Out` / `Reset Zoom` |
| 鼠标（可选） | 设置打开 **Editor: Mouse Wheel Zoom** 后，按住 `Ctrl` 滚轮只缩编辑区 |

工作区可写 `.vscode/settings.json`：`"editor.fontSize": 16`。

---

## 9. 检查更新

- 菜单 **帮助 → Su → 检查更新**，或命令 `Su: 检查更新`。
- 更新源为 GitHub Releases（默认仓库可在 `Su › Update: Repo` 修改）。
- 若要接收开发预览版，打开 `Su › Update: Include Prerelease`。

---

## 10. 常用命令速查

| 命令 | 作用 |
|------|------|
| `Su: 打开 Chat` | 打开右侧 AI 面板（`Ctrl+L`） |
| `Su: 打开 Agent Window` | 对话主界面（大窗） |
| `Su: 打开 IDE Window` | 回到经典编辑器 + 侧栏 Chat |
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

## 11. 隐私说明

- API Key **仅本机** SecretStorage，不随工程提交。
- 对话内容会发往你配置的 Base URL（中转 / 模型服务商），请使用可信中转。
- 不要把 Key 贴进 Chat 或提交到 Git。
