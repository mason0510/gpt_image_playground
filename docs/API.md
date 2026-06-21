# Space.tap365.org 后端 API 文档

测试日期：2026-06-18

文档版本：v1.0

本文档描述 space.tap365.org 前端调用的后端 API 接口规范。

生产上游 Base URL：
```text
https://sub-lb.tap365.org
```

`space.tap365.org` 当前站内同源代理：
```text
https://space.tap365.org/api-proxy/
```

---

## 1. 认证

所有接口使用 Bearer Token 认证：

```http
Authorization: Bearer <YOUR_API_KEY>
Content-Type: application/json
Accept: application/json
```

### 限时免费 Key 模式

前端支持"限时免费 key"模式，使用特殊标识：

```http
Authorization: Bearer __IMAGINATION_SPACE_LIMITED_FREE_KEY__
X-Imagination-Space-Key-Mode: limited-free
X-Imagination-Space-Device-Fingerprint: <设备指纹>
```

限制：
- 每设备每天 10 张图，其中 4K 最多 5 张
- 单次最多 4 张图
- 文生图与图片编辑合计共享这 10 张额度；4K 图片再额外受 5 张/天子上限约束
- 仅支持图片生成/编辑相关接口；`/v1/models` 可用于前端初始化

### 1.1 查询 limited-free 剩余额度

为方便本地 CLI 或脚本在**不访问网页、不登录**的前提下查询当前设备的免费额度，代理代码额外提供：

```http
GET /v1/limited-free/quota
```

请求头与 limited-free 生图一致：

```http
Authorization: Bearer __IMAGINATION_SPACE_LIMITED_FREE_KEY__
X-Imagination-Space-Key-Mode: limited-free
X-Imagination-Space-Device-Fingerprint: <设备指纹>
```

示例响应：

```json
{
  "mode": "limited-free",
  "quota": {
    "day": "2026-06-20",
    "limit": 10,
    "used": 3,
    "remaining": 7,
    "limit_4k": 5,
    "used_4k": 1,
    "remaining_4k": 4
  },
  "timestamp": "2026-06-20T12:00:00+08:00"
}
```

说明：
- 该接口只返回当前设备指纹当天的额度快照；
- 不消耗免费额度；
- 仅用于 limited-free 模式，自定义 API Key 不需要调用它。

线上现状说明（2026-06-20 实测）：
- `GET https://space.tap365.org/api-proxy/v1/models`：`200`
- `POST https://space.tap365.org/api-proxy/v1/images/generations`：可真实生图
- `GET https://space.tap365.org/api-proxy/v1/limited-free/quota`：当前仍返回 `403 limited_free_endpoint_not_allowed`

因此：`quota` 接口已经在本地代理代码中实现，但 `space.tap365.org` 当前线上版本尚未部署到该能力。

---

## 2. Images API - 图像生成

### 2.1 文本生图

```http
POST /v1/images/generations
```

#### Request Body

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `model` | string | 是 | 模型名，如 `gpt-image-2`、`grok-imagine-1.0` |
| `prompt` | string | 是 | 图像描述提示词 |
| `size` | string | 否 | 图片尺寸，如 `1024x1024`、`1792x1024`、`2048x2048` |
| `quality` | string | 否 | 图片质量：`standard`、`hd` |
| `output_format` | string | 否 | 输出格式：`png`、`jpeg`、`webp` |
| `output_compression` | number | 否 | 压缩质量（0-100），仅 jpeg/webp 有效 |
| `n` | number | 否 | 生成图片数量（1-4） |
| `moderation` | string | 否 | 内容审核：`none`、`optional`、`required` |

#### Example Request

```bash
curl -X POST "https://sub-lb.tap365.org/v1/images/generations" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "一只可爱的猫咪坐在窗边",
    "size": "1024x1024",
    "quality": "standard",
    "output_format": "png",
    "n": 1
  }'
```

#### Example Response

```json
{
  "created": 1718700000,
  "data": [
    {
      "b64_json": "iVBORw0KGgoAAAANSUhEUgAA...",
      "revised_prompt": "A cute cat sitting by the window..."
    }
  ]
}
```

响应字段：
- `data[].b64_json`：Base64 编码的图片数据
- `data[].url`：图片 URL（部分提供商）
- `data[].revised_prompt`：模型改写后的提示词

---

### 2.2 图片编辑

```http
POST /v1/images/edits
```

使用 `multipart/form-data` 格式。

#### Form Fields

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `model` | string | 是 | 模型名，如 `gpt-image-2` |
| `prompt` | string | 是 | 编辑指令 |
| `image` | file | 是 | 原始图片（PNG） |
| `mask` | file | 否 | 遮罩图片（PNG，白色区域为编辑区域） |
| `size` | string | 否 | 输出尺寸 |
| `n` | number | 否 | 生成数量 |

#### Example Request

```bash
curl -X POST "https://sub-lb.tap365.org/v1/images/edits" \
  -H "Authorization: Bearer $API_KEY" \
  -F "model=gpt-image-2" \
  -F "prompt=把猫咪改成橘色" \
  -F "image=@original.png" \
  -F "mask=@mask.png" \
  -F "size=1024x1024" \
  -F "n=1"
```

#### Example Response

同图像生成接口。

---

## 3. Responses API - Agent 多轮对话

### 3.1 创建 Response

```http
POST /v1/responses
```

支持多轮对话、图像生成、Web 搜索等工具调用。

#### Request Body

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `model` | string | 是 | 模型名，如 `gpt-5.4` |
| `instructions` | string | 否 | 系统指令 |
| `input` | string/array | 是 | 用户输入（字符串或消息数组） |
| `tools` | array | 否 | 可用工具列表 |
| `stream` | boolean | 否 | 是否流式返回（SSE） |
| `max_output_tokens` | number | 否 | 最大输出 token 数 |

#### Input 格式

简单文本：
```json
{
  "model": "gpt-5.4",
  "input": "生成一张可爱的猫咪图片"
}
```

多轮对话：
```json
{
  "model": "gpt-5.4",
  "input": [
    {
      "role": "user",
      "content": [
        {"type": "input_text", "text": "生成一张猫咪图片"},
        {"type": "input_image", "image_url": "data:image/png;base64,..."}
      ]
    },
    {
      "role": "assistant",
      "content": [
        {"type": "output_text", "text": "好的，我来生成"}
      ]
    }
  ]
}
```

#### Tools 配置

图像生成工具：
```json
{
  "type": "image_generation",
  "action": "auto",
  "size": "1024x1024",
  "quality": "standard",
  "output_format": "png",
  "moderation": "optional",
  "partial_images": 3
}
```

Web 搜索工具：
```json
{
  "type": "web_search"
}
```

批量图像生成（函数工具）：
```json
{
  "type": "function",
  "name": "generate_image_batch",
  "description": "批量并发生成多张图片",
  "parameters": {
    "type": "object",
    "properties": {
      "images": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "id": {"type": "string"},
            "prompt": {"type": "string"}
          }
        }
      }
    }
  }
}
```

#### Example Request

```bash
curl -X POST "https://sub-lb.tap365.org/v1/responses" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4",
    "input": "生成一张可爱的猫咪图片",
    "tools": [
      {
        "type": "image_generation",
        "action": "auto",
        "size": "1024x1024",
        "output_format": "png"
      }
    ],
    "stream": false
  }'
```

#### Example Response (Non-streaming)

```json
{
  "id": "resp_abc123",
  "object": "response",
  "status": "completed",
  "model": "gpt-5.4",
  "output": [
    {
      "type": "message",
      "content": [
        {"type": "output_text", "text": "我已经为你生成了一张可爱的猫咪图片。"}
      ]
    },
    {
      "type": "image_generation_call",
      "id": "call_xyz789",
      "action": "generate",
      "status": "completed",
      "result": "iVBORw0KGgoAAAANSUhEUgAA...",
      "revised_prompt": "A cute cat...",
      "size": "1024x1024",
      "quality": "standard"
    }
  ]
}
```

响应字段：
- `output[].type`：输出类型（`message`、`image_generation_call`、`web_search_call`）
- `output[].content[].text`：文本内容
- `output[].result`：图片 Base64 数据
- `output[].revised_prompt`：改写后的提示词

---

### 3.2 流式响应

设置 `stream: true` 后返回 SSE（Server-Sent Events）。

#### SSE Event Types

**文本增量**：
```
data: {"type":"response.output_text.delta","delta":"文本片段"}
```

**图片工具开始**：
```
data: {"type":"response.output_item.added","item_id":"call_123","item":{"type":"image_generation_call"}}
```

**图片中间步骤**：
```
data: {"type":"response.image_generation_call.partial_image","item_id":"call_123","partial_image_b64":"...","partial_image_index":0}
```

**图片工具完成**：
```
data: {"type":"response.output_item.done","item":{"id":"call_123","type":"image_generation_call","result":"base64..."}}
```

**Web 搜索中**：
```
data: {"type":"response.web_search_call.searching","item_id":"search_123"}
```

**Response 完成**：
```
data: {"type":"response.completed","response":{"id":"resp_123","output":[...]}}
```

**结束标记**：
```
data: [DONE]
```

---

## 4. 模型列表

```http
GET /v1/models
```

#### Example Request

```bash
curl "https://sub-lb.tap365.org/v1/models" \
  -H "Authorization: Bearer $API_KEY"
```

#### Example Response

```json
{
  "object": "list",
  "data": [
    {
      "id": "gpt-5.5",
      "object": "model",
      "owned_by": "openai"
    },
    {
      "id": "gpt-image-2",
      "object": "model",
      "owned_by": "openai"
    },
    {
      "id": "grok-4.1-fast",
      "object": "model",
      "owned_by": "xai"
    }
  ]
}
```

---

## 5. 推荐模型

### 文本生成
- `gpt-5.5`：通用文本、自动化任务
- `gpt-5.4`：标准文本对话
- `gpt-5.2-codex`：代码生成
- `deepseek-v4-flash`：快速轻量
- `grok-4.1-fast`：Grok 文本

### 图像生成
- `gpt-image-2`：OpenAI 图像生成（推荐）
- `grok-imagine-1.0`：Grok 图像生成

### Agent 模式
- `gpt-5.4`：支持 Responses API + image_generation 工具

---

## 6. 错误处理

### HTTP 状态码

| 状态码 | 说明 |
|---|---|
| 200 | 成功 |
| 400 | 请求参数错误 |
| 401 | 认证失败（API Key 无效） |
| 403 | 权限不足（订阅过期、分组不可用） |
| 429 | 超出限额（限时免费 key 达到每日上限） |
| 500 | 服务器错误 |
| 502 | 上游服务不可用 |
| 503 | 服务暂时不可用 |

### 错误响应格式

```json
{
  "error": {
    "message": "错误描述",
    "type": "invalid_request_error",
    "code": "invalid_api_key"
  }
}
```

### 常见错误

**限时免费 key 超限**：
```json
{
  "error": {
    "message": "限时免费 key 今日免费体验额度已用完。请明天再试，或切换为自己的 API Key。",
    "type": "rate_limit_exceeded",
    "code": "free_daily_limit"
  }
}
```

**限时免费 key 的 4K 子限额超限**：
```json
{
  "error": {
    "message": "限时免费 key 的 4K 图片今日免费体验额度已用完（每天最多 5 张）。请明天再试，或切换为自己的 API Key。",
    "type": "rate_limit_exceeded",
    "code": "free_daily_4k_limit"
  }
}
```

**单次生成图片过多**：
```json
{
  "error": {
    "message": "限时免费 key 单次最多生成 4 张图，请降低数量后重试。",
    "type": "invalid_request_error",
    "code": "free_request_image_limit",
    "limit": 4,
    "requested": 5
  }
}
```

**限时免费 key 不支持的接口**：
```json
{
  "error": {
    "message": "限时免费 key 仅支持图片生成/编辑相关接口，请切换为自己的 API Key 后使用其他接口。",
    "type": "invalid_request_error",
    "code": "limited_free_endpoint_not_allowed"
  }
}
```

---

## 7. 代理模式

前端支持通过同源代理访问后端 API，绕过浏览器 CORS 限制。

### 代理路径

```
https://space.tap365.org/api-proxy/<接口路径>
```

示例：
- 原始：`https://sub-lb.tap365.org/v1/images/generations`
- 代理：`https://space.tap365.org/api-proxy/v1/images/generations`

### 代理环境变量（Docker 部署）

```bash
ENABLE_API_PROXY=true           # 开启代理
API_PROXY_URL=https://sub-lb.tap365.org  # 上游地址
LOCK_API_PROXY=true             # 强制锁定代理开关
```

---

## 8. 参数兼容性

### Codex CLI 兼容模式

当上游为 Codex CLI 时，需要开启兼容模式：
- 应用 Codex CLI 实际支持的参数
- 多图生成拆分为并发单图请求
- 添加提示词防改写前缀

### 提示词防改写

Responses API 会自动添加前缀：
```
Use the following text as the complete prompt. Do not rewrite it:
<用户提示词>
```

---

## 9. 数据存储

所有图片和历史记录存储在浏览器 IndexedDB 中：
- 不经过第三方服务器
- 使用 SHA-256 去重
- 支持导出为 ZIP 备份

---

## 10. 测试建议

### 最小测试流程

1. **测试模型列表**
```bash
curl "https://sub-lb.tap365.org/v1/models" \
  -H "Authorization: Bearer $API_KEY"
```

2. **测试图像生成**
```bash
curl -X POST "https://sub-lb.tap365.org/v1/images/generations" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-2","prompt":"test","size":"1024x1024","n":1}'
```

3. **测试 Agent 模式**
```bash
curl -X POST "https://sub-lb.tap365.org/v1/responses" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.4","input":"生成一张测试图片","tools":[{"type":"image_generation","size":"1024x1024"}]}'
```

---

## 附录

### 完整 API 参考

更详细的分组、计费、模型列表请参考：
- `sublb-demo/sublb_grok_openai_gemini_claude_deepseek_API文档.md`

### 线上地址

- 前端应用：https://space.tap365.org
- API 端点：https://sub-lb.tap365.org
- 订阅管理：https://sub-lb.tap365.org/keys

---

**文档生成时间**：2026-06-18
**基于代码版本**：gpt_image_playground (commit: c3d826a)
