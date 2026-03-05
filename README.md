# Image Compress API

## Features

- `POST /api/image-compress/v1/compress`，`multipart/form-data` 上传
- 显式 `responseMode`：
  - `metadata`（默认）：只返回结构化 JSON 元信息（不返回文件本体），适合 Shortcuts/脚本/Agent 做 if/else 分支判断
  - `binary`：直接返回二进制（单图或 ZIP），适合最终下载/保存
- Bearer Token 鉴权（支持多 Token，任一命中即可）
- `binary` 模式：单图返回图片、多图自动返回 ZIP
- 输出格式与输入格式保持一致（不支持转换输出格式）
- 输入格式以文件内容检测为准（不以扩展名/MIME 为准；重命名不等于转格式）
- JPEG 文件名兼容：若上传文件名为 `.jpeg`，输出也使用 `.jpeg` 扩展名（内容仍为 `image/jpeg`）
- 固定压缩参数：
  - JPEG/WebP：固定 `quality=75`
  - PNG：使用 palette 量化的固定配置（有损），并启用“变大回退原图”
- 统一启用“压缩变大回退原图”（避免再编码导致体积增长）
- 默认限制：单图 `20MB`、最多 `30` 张、总计 `80MB`

## Quick Start (Local)

### 1) 安装依赖

```bash
npm install
```

### 2) 创建 `.env`

先生成两个 Token（你也可以按需生成更多）：

```bash
TOKEN_1="$(openssl rand -hex 32)"
TOKEN_2="$(openssl rand -hex 32)"
```

再写入 `.env`（替换为你自己的值）：

```bash
cat > .env <<'EOF'
IMAGE_COMPRESS_API_TOKENS=replace_me_with_a_random_token_1,replace_me_with_a_random_token_2
PORT=3001
HOST=0.0.0.0
EOF
```

### 3) 类型检查 + 构建 + 启动

```bash
npm run check
npm run build
npm run dev
```

说明：

- `npm run dev` 会自动读取 `.env`
- 默认监听 `http://0.0.0.0:3001`
- 退出开发服务：`Ctrl+C`

### 4) 健康检查

```bash
curl http://127.0.0.1:3001/healthz
```

## Quick Start (Docker)

构建镜像：

```bash
docker build -t image-compress-api:local .
```

启动容器（示例：把服务映射到本机 3001 端口）：

```bash
docker run --rm -p 3001:3001 \
  -e IMAGE_COMPRESS_API_TOKENS=replace_me_with_a_random_token_1,replace_me_with_a_random_token_2 \
  image-compress-api:local
```

说明：

- 生产环境更推荐用 Docker Compose，并且不要把后端端口直接暴露到公网（交给 Nginx 反代）
- 如果你已经有 `.env`，也可以用 `--env-file .env` 传入（注意 `.env` 不要提交到仓库）

## 部署注意事项（通用）

- 建议把服务放在反向代理（如 Nginx）之后，不要把容器端口直接暴露到公网。
- 如果使用 Nginx 反代，需要把 `client_max_body_size` 调到不小于 **90m**（服务侧默认总上传上限 80MB）。

## Environment Variables

| Name        | Required | Default   | Description                               |
| ----------- | -------- | --------- | ----------------------------------------- |
| `IMAGE_COMPRESS_API_TOKENS` | Yes      | -         | Bearer 鉴权密钥列表（逗号分隔，服务启动时必填） |
| `PORT`      | No       | `3001`    | 服务监听端口                              |
| `HOST`      | No       | `0.0.0.0` | 服务监听地址                              |

Token 使用建议：

- 按调用方分配独立 Token，避免多人共享同一个密钥
- 某个 Token 泄露时，只撤销该 Token，不影响其他调用方

## API Contract

完整的 OpenAPI 规格见 `openapi.yaml`。

### Endpoint

`POST /api/image-compress/v1/compress`

### Query Params

- `responseMode` (optional, default: `metadata`)
  - `metadata`：只返回 JSON 元信息（不返回文件本体）
  - `binary`：返回二进制文件流（单图或 ZIP）

### Headers

- `Authorization: Bearer <token>`

### Content-Type

- `multipart/form-data`

### Form Fields

- `files` (required, repeatable)
- `responseMode` (optional, same as query param; if both provided, they must match)
- `zipName` (optional, filename for ZIP response)
- Other fields are not supported and will return `400 INVALID_ARGUMENT`.

### Response Rules

- `responseMode=metadata`（默认）
  - `200` 返回 JSON（稳定的业务字段，适合自动化做 if/else）
  - **`200` 不等于一定压缩变小**：请显式判断 `compressed` / `outcome`
- `responseMode=binary`
  - 单图返回图片二进制（与输入格式一致）
  - 多图返回 `application/zip`
  - 输出文件名默认基于原文件名追加 `_compressed` 后缀（例如 `a.png` => `a_compressed.png`）
  - 若再编码后不更小，则回退原图（并保持原文件名）

### Response Headers

> 仅 `responseMode=binary` 返回（辅助信息，不建议作为主要业务分支依据；自动化请优先用 `metadata` 模式的 JSON 字段）。

- `X-Original-Bytes`（输入总字节数）
- `X-Compressed-Bytes`（输出图片总字节数；ZIP 场景不包含容器开销）
- `X-Compression-Ratio`（节省百分比，保留 2 位小数）
- `X-Compressed`（`true`/`false`）
- `X-Outcome`（`compressed`/`fallback_original`）

### Success JSON (`responseMode=metadata`)

`200` 返回结构化 JSON（字段为英文，便于自动化工具稳定判断）：

```json
{
  "success": true,
  "compressed": true,
  "outcome": "compressed",
  "originalBytes": 123456,
  "outputBytes": 78901,
  "savedBytes": 44555,
  "compressionRatio": 0.3606,
  "outputType": "single",
  "outputMimeType": "image/jpeg",
  "outputFileName": "demo_compressed.jpeg",
  "fileCount": 1,
  "results": [
    {
      "originalFileName": "demo.jpeg",
      "outputFileName": "demo_compressed.jpeg",
      "outputMimeType": "image/jpeg",
      "compressed": true,
      "outcome": "compressed",
      "originalBytes": 123456,
      "outputBytes": 78901,
      "savedBytes": 44555,
      "compressionRatio": 0.3606
    }
  ]
}
```

### Error JSON

```json
{
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "file field name must be files"
  }
}
```

### Error Codes

- `400 INVALID_ARGUMENT`
- `401 UNAUTHORIZED`
- `413 PAYLOAD_TOO_LARGE`
- `415 UNSUPPORTED_MEDIA_TYPE`
- `422 PROCESSING_FAILED`
- `500 INTERNAL_ERROR`

## cURL Examples

建议先从 `.env` 读取第一个 Token 用于本地调试：

```bash
TOKEN="$(grep '^IMAGE_COMPRESS_API_TOKENS=' .env | cut -d= -f2- | cut -d, -f1)"
```

关于保存/导出位置：

- API 服务是无状态的：不会在 VPS 上持久化保存图片/ZIP 产物，也不会返回 `downloadUrl`
- `metadata` 模式返回 JSON；`binary` 模式返回二进制文件流
- 保存到哪里由客户端决定（`curl`、网页前端、Shortcuts）
- `curl -o /path/to/save/out.jpg` 是指定“输出文件路径 + 文件名”，不是只指定目录
- 如果你希望“只指定保存目录，并使用服务端返回的文件名（`Content-Disposition`）”，请用 `-OJ`：
  - 新版 curl 可用：`-OJ --output-dir /path/to/save`
  - 若你的 curl 不支持 `--output-dir`，请先 `cd /path/to/save` 再执行 `-OJ`

### Metadata (single file)

```bash
curl -X POST "http://127.0.0.1:3001/api/image-compress/v1/compress?responseMode=metadata" \
  -H "Authorization: Bearer ${TOKEN}" \
  -F "files=@/path/to/demo.jpg"
```

### Binary (single file)

```bash
curl -X POST "http://127.0.0.1:3001/api/image-compress/v1/compress?responseMode=binary" \
  -H "Authorization: Bearer ${TOKEN}" \
  -F "files=@/path/to/demo.jpg" \
  -o /path/to/save/demo_compressed.jpg
```

只指定目录（推荐）：

```bash
curl -X POST "http://127.0.0.1:3001/api/image-compress/v1/compress?responseMode=binary" \
  -H "Authorization: Bearer ${TOKEN}" \
  -F "files=@/path/to/demo.jpg" \
  -OJ --output-dir /path/to/save
```

### Binary (multiple files => ZIP)

```bash
curl -X POST "http://127.0.0.1:3001/api/image-compress/v1/compress?responseMode=binary" \
  -H "Authorization: Bearer ${TOKEN}" \
  -F "files=@/path/to/a.jpg" \
  -F "files=@/path/to/b.png" \
  -F "zipName=my_batch" \
  -o my_batch.zip
```

### Auth failure (expect 401)

```bash
curl -X POST "http://127.0.0.1:3001/api/image-compress/v1/compress" \
  -H "Authorization: Bearer wrong_token" \
  -F "files=@/path/to/demo.jpg"
```

## Testing Checklist

当前仓库未接入 Jest/Vitest，建议按下面顺序做回归：

```bash
npm run check && npm run build
```

手动验证场景：

- 无 `Authorization` / Token 错误（应返回 `401`）
- 使用列表中的不同合法 Token 调用（都应返回 `200`）
- 传入旧参数 `quality/targetFormat/output`（应返回 `400`）
- 上传非 `jpg/png/webp`（应返回 `415`）
- 上传不支持或不可解码的文件（可能返回 `415` 或 `422`）
- `responseMode=metadata`（默认）：返回 JSON；覆盖 `compressed` 与 `fallback_original` 两种业务结果
- `responseMode=binary`：单图返回图片二进制、多图返回 ZIP；并检查 `Content-Disposition` 与辅助 headers
- 总大小超限（应返回 `413`）

## Directory Structure

说明：

- `local-docs/`：本地进度与临时文档目录，默认已在 `.gitignore` 中忽略，不会提交到仓库。

```text
.
├── .github
│   └── workflows
│       ├── ci.yml            # GitHub Actions：类型检查与构建
│       └── deploy.yml         # GitHub Actions：构建并推送镜像（GHCR）
├── local-docs                # 本地文档（不提交）
├── src
│   ├── lib
│   │   ├── auth.ts          # Bearer Token 鉴权（多 Token）
│   │   ├── compress.ts      # Sharp 压缩主逻辑
│   │   ├── validate.ts      # 参数校验与上传限制
│   │   └── zip.ts           # ZIP 流式打包
│   ├── routes
│   │   └── compress.ts      # /api/image-compress/v1/compress 路由
│   ├── types
│   │   └── api.ts           # API 类型与错误模型
│   └── server.ts            # Fastify 启动入口
├── .dockerignore
├── .env.example
├── Dockerfile
├── README.md
├── openapi.yaml
├── package.json
├── package-lock.json
└── tsconfig.json
```
