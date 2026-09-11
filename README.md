# Nihongo Plus

一个面向个人日语学习的本地词库平台。当前版本已经包含：

- 从 `data/个人收集.json` 无损迁移的结构化词库（现有 546 个词条）
- 不调用 AI 的本地即时查重
- 读音、词性细分、动词自他性与活用类型、中文释义、JLPT、标签、笔记
- 动词/形容词活用与逐条例句；主例句数量可设置为 1～5 个
- 搜索、分类/JLPT/完整度筛选、删除、批量选择与子词库
- DeepSeek 官方 `deepseek-v4-flash` 与 OpenCode Go `deepseek-v4.1-flash` 两种补全模式
- 字段级重生成、全部重生成，以及 1～50 路可输入的独立会话并发处理
- 可在设置页配置单个 AI 请求的超时时间（10～600 秒）
- 在词库管理页一键补全所有存在缺失项的词条，完整词条自动跳过
- AI 入库前自动规范化对象、数组与日文词性名称，避免界面出现 `[object Object]`
- 浅色、深色与跟随系统三种显示模式
- 为记忆与考核模块保留稳定的词条 ID 和入口

## 启动

需要 Node.js 20 或更新版本。项目没有第三方运行依赖。

```powershell
node server.mjs
```

打开 <http://127.0.0.1:4173>。

## 配置 AI 服务

推荐直接进入平台的“设置”页，选择提供方并保存对应 API Key。密钥保存在 `data/.secrets.json`，该文件已被 Git 忽略。

也可以复制 `.env.example` 为 `.env`，填入其中一种或两种密钥：

```dotenv
DEEPSEEK_API_KEY=你的密钥
OPENCODE_GO_API_KEY=你的OpenCode-Go密钥
```

`.env` 已被 Git 忽略，不会同步或提交。DeepSeek 官方使用 `https://api.deepseek.com/chat/completions` 和 `deepseek-v4-flash`。OpenCode Go 使用 `https://opencode.ai/zen/go/v1/chat/completions` 和 `deepseek-v4.1-flash`，并为每个单词请求生成独立的 `x-opencode-session`。具体要求见 [OpenCode Go 中文手册](https://opencode.ai/docs/zh-cn/go/)。

OpenCode Go 手册说明该服务面向 OpenCode 与编程 Agent。用于日语词典补全是否符合你的订阅使用范围，请以其当前条款为准。

## 例句注音

词库使用 HTML Ruby 语法保存注音，例如：

```html
<ruby>日本<rt>にほん</rt></ruby>の文化
```

在编辑框中看到标签源码是正常的；编辑框下方的“注音预览”会把假名显示在汉字上方。平台会自动清理由模型误加在标签前的反斜杠。

## 数据结构

- `data/个人收集.json`：原始词表，迁移后仍保留，不再由界面改写。
- `data/词库/个人收集.json`：主结构化词库，所有新增与编辑都写入此处。
- `data/子词库.json`：子词库定义，仅保存词条 ID 引用，避免复制内容。

删除等修改会立即写入 JSON。建议在较大的整理操作前先提交一次 Git，以便随时恢复。

## 两台电脑通过 GitHub 同步

首次在电脑 A：

```powershell
git add .
git commit -m "初始化 Nihongo Plus"
git remote add origin 你的GitHub仓库地址
git push -u origin main
```

电脑 B 克隆仓库并启动。之后每次学习前先 `git pull --rebase`，学习结束后提交 `data/词库/个人收集.json` 和 `data/子词库.json`，再 `git push`。两台电脑不要同时编辑同一份词库；若发生 JSON 冲突，先保留两边版本再人工合并，避免直接覆盖。

## 活用维护建议

动词默认候选：辞書形、ます形、て形、た形、ない形、なかった形、意向形、命令形、可能形、被动形、使役形、使役被动形、条件形（ば）、条件形（たら）。

形容词建议维护：现在肯定、现在否定、过去肯定、过去否定、て形、条件形。每个活用条目分别保存 `example` 日语例句和 `exampleChinese` 中文翻译，日语例句可以包含 `<ruby>` 假名注音。
