# Image Compress API

面向 VPS + Docker + Nginx 的图片压缩服务，支持 `jpg/png/webp` 输入，使用 `quality` 控制压缩参数。

## Features

- `POST /api/v1/compress`，`multipart/form-data` 上传
- Bearer Token 鉴权（单一共享 Token）
- 单图返回图片、多图自动返回 ZIP
- 可选输出格式：`keep|jpg|png|webp`
- `targetFormat=keep` 时启用“压缩变大回退原图”
- 默认限制：单图 `20MB`、最多 `30` 张、总计 `80MB`

## Quick Start (Local)

### 1) 安装依赖

```bash
npm install
```

### 2) 创建 `.env`

先生成 Token：

```bash
openssl rand -hex 32
```

再写入 `.env`（替换为你自己的值）：

```bash
cat > .env <<'EOF'
API_TOKEN=replace_me_with_a_random_token
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

## Environment Variables

| Name        | Required | Default   | Description                               |
| ----------- | -------- | --------- | ----------------------------------------- |
| `API_TOKEN` | Yes      | -         | Bearer 鉴权密钥，服务启动时必填            |
| `PORT`      | No       | `3001`    | 服务监听端口                              |
| `HOST`      | No       | `0.0.0.0` | 服务监听地址                              |

## API Contract

### Endpoint

`POST /api/v1/compress`

### Headers

- `Authorization: Bearer <token>`

### Content-Type

- `multipart/form-data`

### Form Fields

- `files` (required, repeatable)
- `quality` (optional, integer `1..100`, default `75`)
- `targetFormat` (optional, enum `keep|jpg|png|webp`, default `keep`)
- `output` (optional, enum `auto|image|zip`, default `auto`)
- `zipName` (optional, filename for ZIP response)

### Response Rules

- Single file + `output=auto|image` => image binary
- Multiple files => `application/zip` (even if `output=image`)
- `output=zip` => `application/zip`
- 输出文件名默认基于原文件名追加 `_compressed` 后缀（例如 `a.png` => `a_compressed.png`）

### Response Headers

- `X-Original-Bytes`
- `X-Compressed-Bytes`
- `X-Compression-Ratio`

### Error JSON

```json
{
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "quality must be between 1 and 100"
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

建议先从 `.env` 读 Token：

```bash
TOKEN="$(grep '^API_TOKEN=' .env | cut -d= -f2-)"
```

关于保存/导出位置：

- API 服务只返回二进制响应，不会写入你的本地磁盘或 VPS 的固定目录
- 保存到哪里由客户端决定（`curl`、网页前端、Shortcuts）
- `curl -o xx.jpg` 会保存到当前命令执行目录（或你写的绝对路径）

### Single file

```bash
curl -X POST "http://127.0.0.1:3001/api/v1/compress" \
  -H "Authorization: Bearer ${TOKEN}" \
  -F "files=@/path/to/demo.jpg" \
  -F "quality=75" \
  -F "targetFormat=keep" \
  -F "output=image" \
  -o /path/to/save/demo_compressed.jpg
```

### Multiple files (ZIP)

```bash
curl -X POST "http://127.0.0.1:3001/api/v1/compress" \
  -H "Authorization: Bearer ${TOKEN}" \
  -F "files=@/path/to/a.jpg" \
  -F "files=@/path/to/b.png" \
  -F "quality=72" \
  -F "targetFormat=webp" \
  -F "output=zip" \
  -F "zipName=my_batch" \
  -o my_batch.zip
```

### Auth failure (expect 401)

```bash
curl -X POST "http://127.0.0.1:3001/api/v1/compress" \
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
- `quality` 非法（应返回 `400`）
- 上传非 `jpg/png/webp`（应返回 `415`）
- 单图输出（返回图片二进制）
- 多图输出（返回 ZIP）
- 总大小超限（应返回 `413`）

## Directory Structure

```text
.
├── docs
│   └── plan
│       └── image-compress-api-vps.md  # 迁移实施进度与决策记录
├── src
│   ├── lib
│   │   ├── auth.ts          # Bearer Token 鉴权
│   │   ├── compress.ts      # Sharp 压缩与格式转换
│   │   ├── validate.ts      # 参数校验与上传限制
│   │   └── zip.ts           # ZIP 流式打包
│   ├── routes
│   │   └── compress.ts      # /api/v1/compress 路由
│   ├── types
│   │   └── api.ts           # API 类型与错误模型
│   └── server.ts            # Fastify 启动入口
├── Dockerfile
├── README.md
├── package.json
├── package-lock.json
└── tsconfig.json
```
