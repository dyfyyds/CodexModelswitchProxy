# Codex Model Switch Proxy

Codex Model Switch Proxy 是一个给 Codex 使用的本地模型切换代理(前置路由)。它在本机暴露一个 OpenAI 兼容的 `/v1` API，Codex 只需要连接到这个代理；真正调用哪个模型、哪个供应商，由 `config.local.json` 里的模型别名决定。

你可以用它把 Codex 的模型请求切换到：

- mimo
- DeepSeek

- 其他兼容 OpenAI Chat Completions 的 API

## 快速开始

### 1. 克隆项目

```bash
git clone https://github.com/your-username/codex-model-switch-proxy.git
cd codex-model-switch-proxy
```

### 2. 创建配置文件

项目不包含 `.env` 和 `config.local.json`（已在 `.gitignore` 中排除），需要从示例文件复制：

**Windows (PowerShell)：**

```powershell
Copy-Item config.example.json config.local.json
Copy-Item .env.example .env
```

**macOS / Linux：**

```bash
cp config.example.json config.local.json
cp .env.example .env
```

### 3. 填写 API Key

编辑 `.env` 文件，填入你要使用的供应商 API Key：

```env
DEEPSEEK_API_KEY=sk-your-key-here
# MIMO_API_KEY=your-mimo-key
```

只需要填写你实际使用的供应商。通过管理页面添加供应商时，也可以直接填写 Key，会自动写入 `.env`。

### 4. 启动服务

```bash
npm start
```

启动成功后会看到：

```text
Codex model switch proxy listening on http://127.0.0.1:8080/v1
```

### 5. 打开管理页面

浏览器访问：

```text
http://127.0.0.1:8080/
```

在管理页面可以添加、编辑、删除供应商和模型。

## 配置文件说明

### config.local.json

主配置文件，包含端口、供应商和模型路由。从 `config.example.json` 复制后修改。

```json
{
  "port": 8080,
  "host": "127.0.0.1",
  "defaultModel": "deepseek",
  "providers": {
    "deepseek": {
      "baseUrl": "https://api.deepseek.com/v1",
      "protocol": "chat",
      "apiKeyEnv": "DEEPSEEK_API_KEY"
    }
  },
  "models": {
    "deepseek": {
      "provider": "deepseek",
      "upstreamModel": "deepseek-v4-pro"
    }
  }
}
```

如果 `config.local.json` 不存在，服务会自动使用 `config.example.json` 作为兜底。

### .env

环境变量文件，存放 API Key。从 `.env.example` 复制后修改。

```env
DEEPSEEK_API_KEY=sk-...
# MIMO_API_KEY=your-mimo-key
```

## 配置字段说明

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `port` | 监听端口 | `8080` |
| `host` | 监听地址 | `127.0.0.1` |
| `requireProxyKeyEnv` | 可选，代理访问密钥的环境变量名 | 空（不鉴权） |
| `defaultModel` | 请求未指定 model 时的默认模型 | — |
| `allowDirectModels` | 未配置的模型名是否直通 defaultProvider | `false` |
| `defaultProvider` | 直通模型时使用的默认供应商 | — |
| `providers.<id>.baseUrl` | 上游 API 的 `/v1` 根地址 | — |
| `providers.<id>.protocol` | `responses` 或 `chat` | `chat` |
| `providers.<id>.apiKeyEnv` | 读取 API Key 的环境变量名 | — |
| `providers.<id>.headers` | 附加到上游请求的静态 JSON 请求头 | — |
| `models.<alias>.provider` | 使用哪个供应商 | — |
| `models.<alias>.upstreamModel` | 发送给上游的实际模型名 | — |

## 管理页面

启动后访问 `http://127.0.0.1:8080/`，页面包含：

- **供应商与模型**：查看所有已配置的供应商，点击展开查看其下的模型列表。
- **添加供应商**：填写供应商信息和模型，一键保存。
- **编辑 / 删除**：点击卡片上的按钮操作，编辑时回填所有数据。
- **主题切换**：右上角按钮切换深色 / 浅色模式。

## 工作原理

```text
Codex → http://127.0.0.1:8080/v1/responses
         ↓
    代理读取 model 字段
         ↓
    在 config.local.json 中查找别名
         ↓
    转发到对应上游供应商
```

如果上游是 `responses` 协议，代理直接转发。如果上游是 `chat` 协议，代理会将 Responses 请求转换为 Chat Completions 请求，再把结果包装回 Responses 格式。

## 功能

- `GET /v1/models` — 列出所有可用模型
- `POST /v1/responses` — Responses API 代理
- `POST /v1/chat/completions` — Chat Completions API 代理
- 按 model 字段切换不同上游供应商
- Responses ↔ Chat Completions 协议互转
- 流式输出支持（SSE）
- Web 管理页面
- 不依赖第三方 npm 包，Node.js 原生运行

## Codex 配置


在 Codex 配置文件中指向本代理，可以使用 `cc-switch` 快捷切换：

```toml
[model_providers.switch-proxy]
name = "Local Model Switch Proxy"
base_url = "http://127.0.0.1:8080/v1"

[profiles.deepseek]
model_provider = "switch-proxy"
model = "deepseek"
```

`model` 的值对应 `config.local.json` 中 `models` 里的别名。

配置文件位置：

- Windows：`C:\Users\<用户名>\.codex\config.toml`
- macOS / Linux：`~/.codex/config.toml`

示例文件：`examples/codex-config.toml`

## 测试请求

```bash
# 查看可用模型
curl http://127.0.0.1:8080/v1/models

# 发送请求（使用配置中的模型别名）
curl http://127.0.0.1:8080/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek","input":"用一句话介绍这个代理。"}'

# 查看路由信息
curl http://127.0.0.1:8080/debug/routes
```

## 开发命令

```bash
npm start          # 启动服务
npm run dev        # 开发模式（文件变更自动重启）
npm test           # 运行测试
```

指定配置文件：

```bash
CONFIG_PATH=my-config.json npm start
```

## 环境要求

- Node.js 20 或更高版本

## 项目结构

```text
.
├── config.example.json        # 配置示例（复制为 config.local.json 使用）
├── .env.example               # 环境变量示例（复制为 .env 使用）
├── .gitignore                 # Git 忽略规则
├── package.json               # 项目配置
├── public/
│   ├── index.html             # 管理页面
│   ├── styles.css             # 样式
│   └── app.js                 # 前端逻辑
├── src/
│   ├── adapters.js            # Responses 与 Chat Completions 互转
│   ├── config.js              # 配置读写
│   ├── server.js              # HTTP 服务入口
│   └── sse.js                 # 流式输出适配
└── test/                      # 测试文件
```

## 常见问题

### 端口被占用

```text
Error: listen EADDRINUSE: address already in use 127.0.0.1:8080
```

停止占用端口的进程，或修改 `config.local.json` 的 `port` 字段。

### 上游返回 401

API Key 未配置。检查 `.env` 中是否填写了对应 Key，`apiKeyEnv` 是否一致，然后重启服务。

### Unknown model

请求中的 `model` 未在 `config.local.json` 的 `models` 中配置。检查别名是否一致，或将 `allowDirectModels` 设为 `true`。

## 安全建议

- 不要提交 `.env` 和 `config.local.json` 到 Git
- 不要将代理监听到公网
- 局域网访问建议设置 `requireProxyKeyEnv`

## 待处理事项

- [ ] 支持供应商级别的请求速率限制和重试机制
- [ ] 添加请求日志记录（记录每次转发的模型、供应商、耗时、状态码）
- [ ] 管理页面添加请求统计面板（调用次数、成功率、平均耗时）
- [ ] 支持模型别名分组（按用途分组，如"编程"、"推理"、"对话"）
- [ ] 添加 Docker 部署支持（Dockerfile + docker-compose）
- [ ] 支持配置热更新（修改 config.local.json 后无需重启）
- [ ] 管理页面添加 API Key 安全检测（验证 Key 是否有效）
- [ ] 支持多 Key 轮询（同一供应商配置多个 Key，负载均衡）
- [ ] 添加请求超时配置（per-provider 超时时间）
- [ ] 完善单元测试覆盖率
- [ ] 更多代理商的模型测试
- [ ] 管理页面添加导入/导出配置功能
