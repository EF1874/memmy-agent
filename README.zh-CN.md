<br>
<div align="center">
  <a href="https://memmy.cn/">
    <picture>
      <img alt="Memmy Logo" src="docs/assets/banner-zh.png">
    </picture>
  </a>
</div>
<br>
<br>
<p align="center">
    <a href="https://memmy.cn/docs/"><img src="https://img.shields.io/badge/Docs-Get--Start-64716C?labelColor=gray&style=for-the-badge&logo=googledocs&logoColor=white" alt="Docs"></a>
    <a href="https://memmy.cn/"><img src="https://img.shields.io/badge/Visit-Memmy_官网-006400?labelColor=gray&style=for-the-badge&logo=safari&logoColor=white" alt="Memmy 官网"></a>
    <a href="https://github.com/MemTensor/memmy-agent/releases/latest"><img src="https://img.shields.io/badge/News-安装Memmy-ED8D45?labelColor=gray&style=for-the-badge&logo=applenews&logoColor=white" alt="Memmy 最新版"></a>
    <a href="docs/assets/wechat-code.png"><img src="https://img.shields.io/badge/WeCom-Memmy_社区-07C160?labelColor=gray&style=for-the-badge&logo=wechat&logoColor=white" alt="WeChat"></a>
    <a href="https://x.com/Memmy_ai"><img src="https://img.shields.io/badge/Follow-Memmy-000000?labelColor=gray&style=for-the-badge&logo=x&logoColor=white" alt="X"></a>
</p>
<p align="center">
    <a href="https://www.producthunt.com/products/memmy?embed=true&utm_source=badge-top-post-badge&utm_medium=badge&utm_campaign=badge-memmy-agent" target="_blank" rel="noopener noreferrer"><img alt="Memmy Agent - Let every AI remember the same you. | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/top-post-badge.svg?post_id=1203499&theme=light&period=daily&t=1786083567983"></a>
</p>

<div align="center">
[安装](#安装) · [支持的 Agent](#所有-agent-共享同一个-memory-server) · [项目简介](#tencentdb-agent-memory-是什么) · [团队玩法](#一种玩法给一个人的公司组一支会成长的-agent-队伍) · [技术实现](#技术实现) · [Benchmark](#benchmark) · [Roadmap](#roadmap)
</div>

<a id="what"></a>

## Memmy 是什么？

<p align="center">
  <img src="docs/assets/remember-card-cn.png" width="32%" alt="Remember：它记得你说过什么，自动把本机 AI 协作历史整理成结构化记忆">
  <img src="docs/assets/relay-card-cn.png" width="32%" alt="Relay：工具随便换，记忆不掉线，Memmy 会带上项目背景、偏好和进度">
  <img src="docs/assets/react-card-cn.png" width="32%" alt="Act：Memmy 本身也是一个 Agent，可以整理资料、合并方案并继续未完成的任务">
</p>

### 跨 Agent 任务延续
<table align="center">
  <tr align="center" valign="middle">
    <td width="100%" valign="middle">
      <video src="https://github.com/user-attachments/assets/47f86214-76a2-4173-87d2-b89828ce464b" width="100%" controls playsinline></video>
    </td>
  </tr>
</table>

### 你正在用的 Agent，大多都能接入
**deepseek harness, openclaw, hermes, claude code, codex, cursor, workbuddy, openCode, pi...都能用!**
<br>
<br>
![cross-agent-cn.png](docs/assets/cross-agent-cn.png)


### 数据安全
![data-security-cn.png](docs/assets/data-security-cn.png)

<a id="how"></a>

## 如何使用 Memmy？

### 桌面端（推荐）

<p align="center">
  <img src="docs/assets/first-scan-cn.png" width="58%" alt="首次扫描">
  <img src="docs/assets/first-report-cn.png" width="38%" alt="初见报告">
</p>

桌面端负责配置、历史扫描、Agent 接入及本地服务启动，支持 macOS 和 Windows。

<details>
<summary><strong>使用 <code>memmy</code> CLI / TUI</strong></summary>

```bash
memmy onboard                              # 初始化配置和 workspace
memmy status                               # 检查配置、模型和 Provider
memmy agent --message "介绍一下当前工作区"  # 单轮任务
memmy                                      # 进入交互式 TUI
memmy serve                                # 启动 OpenAI 兼容 API（:18990）
```

最小 BYOK 配置位于 `~/.memmy/config.yaml`：

```yaml
agents:
  defaults:
    model: openai/gpt-4.1
    provider: openai
    timezone: "+08:00"
providers:
  openai:
    apiKey: ${OPENAI_API_KEY}
```

</details>

<details>
<summary><strong>使用 <code>memmy-memory</code> CLI</strong></summary>

供 Agent、脚本和调试流程访问本地记忆服务：

```bash
memmy-memory init
memmy-memory health
memmy-memory search "项目里的记忆策略"
memmy-memory add "这是一条需要保存的知识"
memmy-memory get <id>
```

默认连接 `http://127.0.0.1:18960`；可用 `--url`、`--token`、`--config`、`--source` 和 `--user-id` 指定服务与命名空间。

</details>

<details>
<summary><strong>从源码启动完整开发环境</strong></summary>

```bash
git clone https://github.com/MemTensor/memmy-agent.git
cd memmy-agent
cp .env.example .env
bash scripts/dev-start.sh
```

脚本会安装依赖、构建服务并启动开发环境。需要 Node.js `>=22` 和 npm；Windows 请使用 Git Bash。

</details>

完整安装和配置说明见 [入门指南](docs/cn/start/getting-started.mdx)。

<a id="architecture"></a>

## Memmy 如何工作？

Memmy 将 Agent 历史整理为长期记忆，并按任务召回相关内容。Desktop、CLI 和 API 共享同一套 Memory 与 Agent Runtime。

| 层级                          | 负责什么                        |
| ----------------------------- | ------------------------------- |
| 🧠**Memory Layer**      | 导入、存储、检索与溯源          |
| 🤖**Agent Runtime**     | 模型、任务、工具、MCP 与 Skills |
| 🔌**Integration Layer** | 消息渠道、第三方服务与兼容 API  |
| 🖥️**User Interface**  | Desktop、CLI / TUI 与本地 Web   |

<p align="center">
  <img src="docs/assets/memmy-architecture-zh.png" alt="Memmy 系统架构：多个 Agent 和入口共享本地 Memory 与 Agent Runtime">
</p>

架构、记忆服务和接入方式的详细说明见 [Memmy 文档](https://memmy.bot/docs/)。

<a id="development"></a>

## 开发与贡献

仓库使用 npm workspaces。在根目录运行：

```bash
npm install
npm run dev:desktop     # 启动桌面前端与 Electron 壳
npm run build           # 构建 Memory 和所有 workspace
npm run lint            # 代码检查
npm run typecheck       # 类型检查
npm run test            # 运行测试
```

欢迎贡献 Agent 适配器、Provider、系统支持、测试、文档和翻译。

- [报告问题或建议功能](https://github.com/MemTensor/memmy-agent/issues)
- [查看和提交 Pull Request](https://github.com/MemTensor/memmy-agent/pulls)
- [阅读项目文档](https://memmy.bot/docs/)

<a id="roadmap"></a>


## 路线图

Memmy 做的是**个人记忆基础设施**，边界不止于 Coding Agent：

- **更多记忆来源**——从 AI 对话扩展到浏览器行为、本地文档，乃至更多终端与硬件设备。
- **团队协作**——规划中的 Agent 间协作能力，让团队成员的 AI 助手在隐私保护下共享知识。

## 致谢

Memmy 站在一群优秀的开源项目肩上，我们对此心怀感激。

- **[OpenClaw](https://github.com/openclaw/openclaw)** ——开源个人 AI 助手的先行者，它对多平台消息渠道的探索直接启发了 Memmy 的渠道连接设计。
- **[hermes-agent](https://github.com/NousResearch/hermes-agent)** ——Nous Research 打造的自我进化 Agent，它在持久记忆与技能自学习上的实践让我们看到 Agent 可以「越用越懂你」。
- **[nanobot](https://github.com/HKUDS/nanobot)** ——从极简原型生长为功能完备的开源 Agent 平台，它对 Agent 循环与 MCP 集成的工程实践为 Memmy 的核心设计提供了重要参考。

开源的意义在于让好的想法流动起来，我们希望 Memmy 也能成为这条河流的一部分。

## 贡献者

感谢每一位让 Memmy 变得更好的贡献者 ❤️
<br>
<br>
<a href="https://github.com/MemTensor/memmy-agent/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=MemTensor/memmy-agent" alt="memmy-agent contributors" />
</a>
<br>
<div align="center">
  <a href="https://memmy.cn/">
    <picture>
      <img alt="Memmy Logo" src="docs/assets/banner-zh.png">
    </picture>
  </a>
</div>
<br>
<br>
<p align="center">
    <a href="https://memmy.cn/docs/"><img src="https://img.shields.io/badge/Docs-Get--Start-64716C?labelColor=gray&style=for-the-badge&logo=googledocs&logoColor=white" alt="Docs"></a>
    <a href="https://memmy.cn/"><img src="https://img.shields.io/badge/Visit-Memmy_官网-006400?labelColor=gray&style=for-the-badge&logo=safari&logoColor=white" alt="Memmy 官网"></a>
    <a href="https://github.com/MemTensor/memmy-agent/releases/latest"><img src="https://img.shields.io/badge/News-安装Memmy-ED8D45?labelColor=gray&style=for-the-badge&logo=applenews&logoColor=white" alt="Memmy 最新版"></a>
    <a href="docs/assets/wechat-code.png"><img src="https://img.shields.io/badge/WeCom-Memmy_社区-07C160?labelColor=gray&style=for-the-badge&logo=wechat&logoColor=white" alt="WeChat"></a>
    <a href="https://x.com/Memmy_ai"><img src="https://img.shields.io/badge/Follow-Memmy-000000?labelColor=gray&style=for-the-badge&logo=x&logoColor=white" alt="X"></a>
</p>
<p align="center">
    <a href="https://www.producthunt.com/products/memmy?embed=true&utm_source=badge-top-post-badge&utm_medium=badge&utm_campaign=badge-memmy-agent" target="_blank" rel="noopener noreferrer"><img alt="Memmy Agent - Let every AI remember the same you. | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/top-post-badge.svg?post_id=1203499&theme=light&period=daily&t=1786083567983"></a>
</p>

<div align="center">
[安装](#安装) · [支持的 Agent](#所有-agent-共享同一个-memory-server) · [项目简介](#tencentdb-agent-memory-是什么) · [团队玩法](#一种玩法给一个人的公司组一支会成长的-agent-队伍) · [技术实现](#技术实现) · [Benchmark](#benchmark) · [Roadmap](#roadmap)
</div>

<a id="what"></a>

## Memmy 是什么？

<p align="center">
  <img src="docs/assets/remember-card-cn.png" width="32%" alt="Remember：它记得你说过什么，自动把本机 AI 协作历史整理成结构化记忆">
  <img src="docs/assets/relay-card-cn.png" width="32%" alt="Relay：工具随便换，记忆不掉线，Memmy 会带上项目背景、偏好和进度">
  <img src="docs/assets/react-card-cn.png" width="32%" alt="Act：Memmy 本身也是一个 Agent，可以整理资料、合并方案并继续未完成的任务">
</p>

### 跨 Agent 任务延续
<table align="center">
  <tr align="center" valign="middle">
    <td width="100%" valign="middle">
      <video src="https://github.com/user-attachments/assets/47f86214-76a2-4173-87d2-b89828ce464b" width="100%" controls playsinline></video>
    </td>
  </tr>
</table>

### 你正在用的 Agent，大多都能接入
**deepseek harness, openclaw, hermes, claude code, codex, cursor, workbuddy, openCode, pi...都能用!**
<br>
<br>
![cross-agent-cn.png](docs/assets/cross-agent-cn.png)


### 数据安全
![data-security-cn.png](docs/assets/data-security-cn.png)

<a id="how"></a>

## 如何使用 Memmy？

### 桌面端（推荐）
![first-sight-cn.png](docs/assets/first-sight-cn.png)

桌面端负责配置、历史扫描、Agent 接入及本地服务启动，支持 macOS 和 Windows。

<details>
<summary><strong>使用 <code>memmy</code> CLI / TUI</strong></summary>

```bash
memmy onboard                              # 初始化配置和 workspace
memmy status                               # 检查配置、模型和 Provider
memmy agent --message "介绍一下当前工作区"  # 单轮任务
memmy                                      # 进入交互式 TUI
memmy serve                                # 启动 OpenAI 兼容 API（:18990）
```

最小 BYOK 配置位于 `~/.memmy/config.yaml`：

```yaml
agents:
  defaults:
    model: openai/gpt-4.1
    provider: openai
    timezone: "+08:00"
providers:
  openai:
    apiKey: ${OPENAI_API_KEY}
```

</details>

<details>
<summary><strong>使用 <code>memmy-memory</code> CLI</strong></summary>

供 Agent、脚本和调试流程访问本地记忆服务：

```bash
memmy-memory init
memmy-memory health
memmy-memory search "项目里的记忆策略"
memmy-memory add "这是一条需要保存的知识"
memmy-memory get <id>
```

默认连接 `http://127.0.0.1:18960`；可用 `--url`、`--token`、`--config`、`--source` 和 `--user-id` 指定服务与命名空间。

</details>

<details>
<summary><strong>从源码启动完整开发环境</strong></summary>

```bash
git clone https://github.com/MemTensor/memmy-agent.git
cd memmy-agent
cp .env.example .env
bash scripts/dev-start.sh
```

脚本会安装依赖、构建服务并启动开发环境。需要 Node.js `>=22` 和 npm；Windows 请使用 Git Bash。

</details>

完整安装和配置说明见 [入门指南](docs/cn/start/getting-started.mdx)。

<a id="architecture"></a>

## Memmy 如何工作？

Memmy 将 Agent 历史整理为长期记忆，并按任务召回相关内容。Desktop、CLI 和 API 共享同一套 Memory 与 Agent Runtime。

| 层级                          | 负责什么                        |
| ----------------------------- | ------------------------------- |
| 🧠**Memory Layer**      | 导入、存储、检索与溯源          |
| 🤖**Agent Runtime**     | 模型、任务、工具、MCP 与 Skills |
| 🔌**Integration Layer** | 消息渠道、第三方服务与兼容 API  |
| 🖥️**User Interface**  | Desktop、CLI / TUI 与本地 Web   |

<p align="center">
  <img src="docs/assets/memmy-architecture-zh.png" alt="Memmy 系统架构：多个 Agent 和入口共享本地 Memory 与 Agent Runtime">
</p>

架构、记忆服务和接入方式的详细说明见 [Memmy 文档](https://memmy.bot/docs/)。

<a id="development"></a>

## 开发与贡献

仓库使用 npm workspaces。在根目录运行：

```bash
npm install
npm run dev:desktop     # 启动桌面前端与 Electron 壳
npm run build           # 构建 Memory 和所有 workspace
npm run lint            # 代码检查
npm run typecheck       # 类型检查
npm run test            # 运行测试
```

欢迎贡献 Agent 适配器、Provider、系统支持、测试、文档和翻译。

- [报告问题或建议功能](https://github.com/MemTensor/memmy-agent/issues)
- [查看和提交 Pull Request](https://github.com/MemTensor/memmy-agent/pulls)
- [阅读项目文档](https://memmy.bot/docs/)

<a id="roadmap"></a>


## 路线图

Memmy 做的是**个人记忆基础设施**，边界不止于 Coding Agent：

- **更多记忆来源**——从 AI 对话扩展到浏览器行为、本地文档，乃至更多终端与硬件设备。
- **团队协作**——规划中的 Agent 间协作能力，让团队成员的 AI 助手在隐私保护下共享知识。

## 致谢

Memmy 站在一群优秀的开源项目肩上，我们对此心怀感激。

- **[OpenClaw](https://github.com/openclaw/openclaw)** ——开源个人 AI 助手的先行者，它对多平台消息渠道的探索直接启发了 Memmy 的渠道连接设计。
- **[hermes-agent](https://github.com/NousResearch/hermes-agent)** ——Nous Research 打造的自我进化 Agent，它在持久记忆与技能自学习上的实践让我们看到 Agent 可以「越用越懂你」。
- **[nanobot](https://github.com/HKUDS/nanobot)** ——从极简原型生长为功能完备的开源 Agent 平台，它对 Agent 循环与 MCP 集成的工程实践为 Memmy 的核心设计提供了重要参考。

开源的意义在于让好的想法流动起来，我们希望 Memmy 也能成为这条河流的一部分。

## 贡献者

感谢每一位让 Memmy 变得更好的贡献者 ❤️
<br>
<br>
<a href="https://github.com/MemTensor/memmy-agent/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=MemTensor/memmy-agent" alt="memmy-agent contributors" />
</a>
<br>
<div align="center">
  <a href="https://memmy.cn/">
    <picture>
      <img alt="Memmy Logo" src="docs/assets/banner-zh.png">
    </picture>
  </a>
</div>
<br>
<br>
<p align="center">
    <a href="https://memmy.cn/docs/"><img src="https://img.shields.io/badge/Docs-Get--Start-64716C?labelColor=gray&style=for-the-badge&logo=googledocs&logoColor=white" alt="Docs"></a>
    <a href="https://memmy.cn/"><img src="https://img.shields.io/badge/Visit-Memmy_官网-006400?labelColor=gray&style=for-the-badge&logo=safari&logoColor=white" alt="Memmy 官网"></a>
    <a href="https://github.com/MemTensor/memmy-agent/releases/latest"><img src="https://img.shields.io/badge/News-安装Memmy-ED8D45?labelColor=gray&style=for-the-badge&logo=applenews&logoColor=white" alt="Memmy 最新版"></a>
    <a href="docs/assets/wechat-code.png"><img src="https://img.shields.io/badge/WeCom-Memmy_社区-07C160?labelColor=gray&style=for-the-badge&logo=wechat&logoColor=white" alt="WeChat"></a>
    <a href="https://x.com/Memmy_ai"><img src="https://img.shields.io/badge/Follow-Memmy-000000?labelColor=gray&style=for-the-badge&logo=x&logoColor=white" alt="X"></a>
</p>
<p align="center">
    <a href="https://www.producthunt.com/products/memmy?embed=true&utm_source=badge-top-post-badge&utm_medium=badge&utm_campaign=badge-memmy-agent" target="_blank" rel="noopener noreferrer"><img alt="Memmy Agent - Let every AI remember the same you. | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/top-post-badge.svg?post_id=1203499&theme=light&period=daily&t=1786083567983"></a>
</p>

<div align="center">
[安装](#安装) · [支持的 Agent](#所有-agent-共享同一个-memory-server) · [项目简介](#tencentdb-agent-memory-是什么) · [团队玩法](#一种玩法给一个人的公司组一支会成长的-agent-队伍) · [技术实现](#技术实现) · [Benchmark](#benchmark) · [Roadmap](#roadmap)
</div>

<a id="what"></a>

## Memmy 是什么？

<p align="center">
  <img src="docs/assets/remember-card-cn.png" width="32%" alt="Remember：它记得你说过什么，自动把本机 AI 协作历史整理成结构化记忆">
  <img src="docs/assets/relay-card-cn.png" width="32%" alt="Relay：工具随便换，记忆不掉线，Memmy 会带上项目背景、偏好和进度">
  <img src="docs/assets/react-card-cn.png" width="32%" alt="Act：Memmy 本身也是一个 Agent，可以整理资料、合并方案并继续未完成的任务">
</p>

### 跨 Agent 任务延续
<table align="center">
  <tr align="center" valign="middle">
    <td width="100%" valign="middle">
      <video src="https://github.com/user-attachments/assets/47f86214-76a2-4173-87d2-b89828ce464b" width="100%" controls playsinline></video>
    </td>
  </tr>
</table>

### 你正在用的 Agent，大多都能接入
**deepseek harness, openclaw, hermes, claude code, codex, cursor, workbuddy, openCode, pi...都能用!**
<br>
<br>
![cross-agent-cn.png](docs/assets/cross-agent-cn.png)


### 数据安全
![data-security-cn.png](docs/assets/data-security-cn.png)

<a id="how"></a>

## 如何使用 Memmy？

### 桌面端（推荐）
![first-sight-cn.png](docs/assets/first-sight-cn.png)

桌面端负责配置、历史扫描、Agent 接入及本地服务启动，支持 macOS 和 Windows。

<details>
<summary><strong>使用 <code>memmy</code> CLI / TUI</strong></summary>

```bash
memmy onboard                              # 初始化配置和 workspace
memmy status                               # 检查配置、模型和 Provider
memmy agent --message "介绍一下当前工作区"  # 单轮任务
memmy                                      # 进入交互式 TUI
memmy serve                                # 启动 OpenAI 兼容 API（:18990）
```

最小 BYOK 配置位于 `~/.memmy/config.yaml`：

```yaml
agents:
  defaults:
    model: openai/gpt-4.1
    provider: openai
    timezone: "+08:00"
providers:
  openai:
    apiKey: ${OPENAI_API_KEY}
```

</details>

<details>
<summary><strong>使用 <code>memmy-memory</code> CLI</strong></summary>

供 Agent、脚本和调试流程访问本地记忆服务：

```bash
memmy-memory init
memmy-memory health
memmy-memory search "项目里的记忆策略"
memmy-memory add "这是一条需要保存的知识"
memmy-memory get <id>
```

默认连接 `http://127.0.0.1:18960`；可用 `--url`、`--token`、`--config`、`--source` 和 `--user-id` 指定服务与命名空间。

</details>

<details>
<summary><strong>从源码启动完整开发环境</strong></summary>

```bash
git clone https://github.com/MemTensor/memmy-agent.git
cd memmy-agent
cp .env.example .env
bash scripts/dev-start.sh
```

脚本会安装依赖、构建服务并启动开发环境。需要 Node.js `>=22` 和 npm；Windows 请使用 Git Bash。

</details>

完整安装和配置说明见 [入门指南](docs/cn/start/getting-started.mdx)。

<a id="architecture"></a>

## Memmy 如何工作？

Memmy 将 Agent 历史整理为长期记忆，并按任务召回相关内容。Desktop、CLI 和 API 共享同一套 Memory 与 Agent Runtime。

| 层级                          | 负责什么                        |
| ----------------------------- | ------------------------------- |
| 🧠**Memory Layer**      | 导入、存储、检索与溯源          |
| 🤖**Agent Runtime**     | 模型、任务、工具、MCP 与 Skills |
| 🔌**Integration Layer** | 消息渠道、第三方服务与兼容 API  |
| 🖥️**User Interface**  | Desktop、CLI / TUI 与本地 Web   |

<p align="center">
  <img src="docs/assets/memmy-architecture-zh.png" alt="Memmy 系统架构：多个 Agent 和入口共享本地 Memory 与 Agent Runtime">
</p>

架构、记忆服务和接入方式的详细说明见 [Memmy 文档](https://memmy.bot/docs/)。

<a id="development"></a>

## 开发与贡献

仓库使用 npm workspaces。在根目录运行：

```bash
npm install
npm run dev:desktop     # 启动桌面前端与 Electron 壳
npm run build           # 构建 Memory 和所有 workspace
npm run lint            # 代码检查
npm run typecheck       # 类型检查
npm run test            # 运行测试
```

欢迎贡献 Agent 适配器、Provider、系统支持、测试、文档和翻译。

- [报告问题或建议功能](https://github.com/MemTensor/memmy-agent/issues)
- [查看和提交 Pull Request](https://github.com/MemTensor/memmy-agent/pulls)
- [阅读项目文档](https://memmy.bot/docs/)

<a id="roadmap"></a>


## 路线图

Memmy 做的是**个人记忆基础设施**，边界不止于 Coding Agent：

- **更多记忆来源**——从 AI 对话扩展到浏览器行为、本地文档，乃至更多终端与硬件设备。
- **团队协作**——规划中的 Agent 间协作能力，让团队成员的 AI 助手在隐私保护下共享知识。

## 致谢

Memmy 站在一群优秀的开源项目肩上，我们对此心怀感激。

- **[OpenClaw](https://github.com/openclaw/openclaw)** ——开源个人 AI 助手的先行者，它对多平台消息渠道的探索直接启发了 Memmy 的渠道连接设计。
- **[hermes-agent](https://github.com/NousResearch/hermes-agent)** ——Nous Research 打造的自我进化 Agent，它在持久记忆与技能自学习上的实践让我们看到 Agent 可以「越用越懂你」。
- **[nanobot](https://github.com/HKUDS/nanobot)** ——从极简原型生长为功能完备的开源 Agent 平台，它对 Agent 循环与 MCP 集成的工程实践为 Memmy 的核心设计提供了重要参考。

开源的意义在于让好的想法流动起来，我们希望 Memmy 也能成为这条河流的一部分。

## 贡献者

感谢每一位让 Memmy 变得更好的贡献者 ❤️
<br>
<br>
<a href="https://github.com/MemTensor/memmy-agent/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=MemTensor/memmy-agent" alt="memmy-agent contributors" />
</a>
