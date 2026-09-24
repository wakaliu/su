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
- Chat 面板顶部：**模型列表** 按钮

在 Chat **输入区上方**的下拉里可选：

- **Auto (默认模型名)** → 使用 `Su › Model`
- 或列表中任一模型 id → 本次对话 / Agent 使用该模型

---

## 4. 使用 Chat（问答）

1. `Ctrl+L` 打开右侧 **Su AI / Chat**。
2. 模式切到 **Chat**。
3. 可选勾选「附带当前选区」，把编辑器选中代码一并发送。
4. Enter 发送，Shift+Enter 换行；生成中可点 **停止**。
5. **新对话** 清空当前工作区会话历史。

助手回复支持基础 Markdown（代码块、列表、粗体等）。

---

## 5. 使用 Agent（改文件 + Diff）

1. Chat 面板切换到 **Agent**。
2. 用自然语言下任务（如「给 README 加一节安装说明」）。
3. Agent 可在**当前工作区**内列目录、读文件、写文件、替换文本；终端命令默认每次需确认。
4. 写入后进入待审阅：用 **审阅 Diff** / 命令 `Su: 审阅 Agent 改动`。
5. **Keep** 保留改动，**Reject** 恢复修改前（新建文件则删除）。

相关设置：

- `Su › Agent: Max Steps`：单轮最大工具步数  
- `Su › Agent: Enable Terminal`：是否允许 `run_terminal`（仍需确认）

---

## 6. Ghost Text（行内补全）

- 编辑代码时，灰色预览建议补全；**Tab** 接受（与编辑器默认一致）。
- 开关：命令 `Su: 切换 Ghost Text`，或设置 `Su › Ghost Text: Enabled`。
- Ghost Text **始终使用默认模型** `Su › Model`（不受 Chat 下拉影响）。

---

## 7. 检查更新

- 菜单 **帮助 → Su → 检查更新**，或命令 `Su: 检查更新`。
- 更新源为 GitHub Releases（默认仓库可在 `Su › Update: Repo` 修改）。
- 若要接收开发预览版，打开 `Su › Update: Include Prerelease`。

---

## 8. 常用命令速查

| 命令 | 作用 |
|------|------|
| `Su: 打开 Chat` | 打开右侧 AI 面板（`Ctrl+L`） |
| `Su: 设置 API Key` | 保存密钥到本机 |
| `Su: AI 配置（中转/模型）` | 打开 Base URL / Models 设置 |
| `Su: 编辑模型列表` | 增删可选模型 |
| `Su: 切换 Ghost Text` | 开关行内补全 |
| `Su: 审阅 Agent 改动` | Keep / Reject |
| `Su: 检查更新` | 查 GitHub Releases |
| `Su: 用户手册` | 打开本文 |

---

## 9. 隐私说明

- API Key **仅本机** SecretStorage，不随工程提交。
- 对话内容会发往你配置的 Base URL（中转 / 模型服务商），请使用可信中转。
- 不要把 Key 贴进 Chat 或提交到 Git。
