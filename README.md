# Image Compress API

面向 VPS + Docker + Nginx 的图片压缩服务，支持 `jpg/png/webp` 输入，使用 `quality` 控制压缩参数。

## Features

- `POST /api/v1/compress`，`multipart/form-data` 上传
- Bearer Token 鉴权
- 单图返回图片、多图返回 ZIP
- 可选输出格式：`keep|jpg|png|webp`
- `targetFormat=keep` 时启用“压缩变大回退原图”
- 中等限制默认值：单图 `20MB`、最多 `30` 张、总计 `80MB`

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
├── .gitignore
├── package.json
├── package-lock.json
└── tsconfig.json
```

## API Contract

### Endpoint

`POST /api/v1/compress`

### Headers

- `Authorization: Bearer <token>`

### Form Fields

- `files` (required, repeatable)
- `quality` (optional, integer `1..100`, default `75`)
- `targetFormat` (optional, enum `keep|jpg|png|webp`, default `keep`)
- `output` (optional, enum `auto|image|zip`, default `auto`)
- `zipName` (optional, filename for ZIP response)

### Response Rules

- Single file + `output=auto|image` => image binary
- Multiple files or `output=zip` => `application/zip`

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

## Local Development

```bash
npm install
npm run check
npm run build
API_TOKEN=replace_me npm run dev
```

服务默认监听 `0.0.0.0:3001`，健康检查：`GET /healthz`。

## cURL Examples

### Single file

```bash
curl -X POST "http://127.0.0.1:3001/api/v1/compress" \
  -H "Authorization: Bearer replace_me" \
  -F "files=@/path/to/demo.jpg" \
  -F "quality=75" \
  -F "targetFormat=keep" \
  -F "output=image" \
  -o compressed.jpg
```

### Multiple files (ZIP)

```bash
curl -X POST "http://127.0.0.1:3001/api/v1/compress" \
  -H "Authorization: Bearer replace_me" \
  -F "files=@/path/to/a.jpg" \
  -F "files=@/path/to/b.png" \
  -F "quality=72" \
  -F "targetFormat=webp" \
  -F "output=zip" \
  -F "zipName=my_batch" \
  -o my_batch.zip
```

## Docker

```bash
npm install
docker build -t image-compress-api:local .
docker run --rm -p 3001:3001 -e API_TOKEN=replace_me image-compress-api:local
```

## Deployment Snippets

### Docker Compose service

```yaml
image-compress-api:
  build:
    context: /path/to/image-compress-api
  container_name: image-compress-api
  environment:
    - NODE_ENV=production
    - TZ=Asia/Shanghai
    - API_TOKEN=${IMAGE_COMPRESS_API_TOKEN}
    - PORT=3001
  expose:
    - "3001"
  networks:
    - webnet
  healthcheck:
    test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:3001/healthz || exit 1"]
    interval: 30s
    timeout: 5s
    retries: 3
  restart: unless-stopped
```

### Nginx (`zzg.sh` server block)

```nginx
client_max_body_size 90m;

location /api/ {
    proxy_pass http://image-compress-api:3001;
    proxy_http_version 1.1;
    proxy_read_timeout 120s;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```
