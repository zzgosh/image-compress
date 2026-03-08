# Image Compress API

## Features

- `POST /api/image-compress/v1/compress`：上传图片并返回结构化 JSON metadata
- `GET /api/image-compress/v1/results/:resultId?token=...`：下载同一次压缩生成的临时产物
- 单次压缩，多端复用：客户端先看 metadata 决策，再按 `download.url` 下载，不会重复压缩
- 临时结果资源有边界：短 TTL、单次下载、总临时存储上限、过期自动清理
- Bearer Token 鉴权（压缩接口）；下载接口使用一次性签名 URL
- 输出格式与输入格式保持一致（不支持格式转换）
- 输入格式以文件内容检测为准（不以扩展名/MIME 为准）
- 默认保留原始文件名（支持中文/英文/Unicode）；仅清理路径分隔符、控制字符和保留非法字符
- JPEG 文件名兼容：若上传文件名为 `.jpeg`，输出也使用 `.jpeg`
- 固定压缩参数：
  - JPEG/WebP：固定 `quality=75`
  - PNG：使用 palette 量化固定配置（有损），并启用“变大回退原图”
- 默认上传限制（可通过环境变量调整）：单图 `20MB`、最多 `30` 张、总计 `80MB`

## Protocol Overview

现在的流程固定为两步：

1. `POST /api/image-compress/v1/compress`
   - 服务完成压缩
   - 返回 JSON metadata
   - JSON 中包含一次性 `download.url`
2. `GET download.url`
   - 下载这一次压缩生成的最终产物
   - 成功下载后资源删除
   - 超时未下载也会自动清理

这套协议的目标是：

- 客户端能稳定读取 metadata 做分支判断
- 客户端需要文件时仍能拿到同一次压缩产物
- 服务端避免因为“metadata + binary 双请求”而重复压缩

## Quick Start (Local)

### 1) 安装依赖

```bash
npm install
```

### 2) 创建 `.env`

先生成两个 Token：

```bash
TOKEN_1="$(openssl rand -hex 32)"
TOKEN_2="$(openssl rand -hex 32)"
```

再写入 `.env`：

```bash
cat > .env <<'EOF'
IMAGE_COMPRESS_API_TOKENS=replace_me_with_a_random_token_1,replace_me_with_a_random_token_2
PORT=3001
HOST=0.0.0.0
PUBLIC_BASE_URL=http://127.0.0.1:3001
UPLOAD_MAX_FILE_SIZE=20MB
UPLOAD_MAX_FILE_COUNT=30
UPLOAD_MAX_TOTAL_SIZE=80MB
RESULT_TTL_SECONDS=300
RESULT_STORAGE_MAX_SIZE=256MB
EOF
```

说明：

- `PUBLIC_BASE_URL` 建议显式配置；这样返回的 `download.url` 会稳定指向外部可访问地址
- `UPLOAD_MAX_FILE_SIZE` / `UPLOAD_MAX_FILE_COUNT` / `UPLOAD_MAX_TOTAL_SIZE` 是上传入口限制
- `RESULT_TTL_SECONDS` 是临时结果的保留时长
- `RESULT_STORAGE_MAX_SIZE` 是服务端临时结果目录的总存储上限
- 容量型环境变量支持原始字节整数，或使用大写 `MB` 后缀，例如 `20MB`、`80MB`、`256MB`

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

启动容器：

```bash
docker run --rm -p 3001:3001 \
  -e IMAGE_COMPRESS_API_TOKENS=replace_me_with_a_random_token_1,replace_me_with_a_random_token_2 \
  -e PUBLIC_BASE_URL=http://127.0.0.1:3001 \
  image-compress-api:local
```

说明：

- 生产环境更推荐用 Docker Compose + Nginx 反代
- 不建议把后端端口直接暴露到公网

## Deployment Notes

- 建议把服务放在反向代理（如 Nginx）之后
- 如果使用 Nginx 反代，需要在 **Nginx 配置文件** 里设置 `client_max_body_size`；这不是 `.env` 变量
  - 默认上传总上限是 `80MB`，服务端会额外预留约 `10MB` multipart 开销，所以默认可先设为不小于 **90m**
  - 如果你把 `UPLOAD_MAX_TOTAL_SIZE` 调大了，也要同步把 Nginx 的 `client_max_body_size` 调大
  - 作用：避免请求还没到 Node/Fastify，就先被 Nginx 以请求体过大拦掉
- 生产环境建议显式配置 `PUBLIC_BASE_URL`
- 如果未设置 `RESULT_STORAGE_DIR`：
  - 本机直接运行：默认落到系统临时目录下的 `image-compress-api-results`
  - Docker 容器内运行：默认落到容器内的 `/tmp/image-compress-api-results`
  - 如果容器重建且未挂载卷，这些临时结果会一起消失
- 服务只会清理自己创建的临时结果文件，不会递归删除 `RESULT_STORAGE_DIR` 里的其他内容

## Environment Variables

| Name | Required | Default | Description |
| --- | --- | --- | --- |
| `IMAGE_COMPRESS_API_TOKENS` | Yes | - | Bearer 鉴权 Token 列表（逗号分隔） |
| `PORT` | No | `3001` | 服务监听端口 |
| `HOST` | No | `0.0.0.0` | 服务监听地址 |
| `PUBLIC_BASE_URL` | No | 按请求头推断 | 返回给客户端的下载基地址 |
| `UPLOAD_MAX_FILE_SIZE` | No | `20MB` | 单个上传文件大小上限 |
| `UPLOAD_MAX_FILE_COUNT` | No | `30` | 单次请求允许上传的最大文件数 |
| `UPLOAD_MAX_TOTAL_SIZE` | No | `80MB` | 单次请求所有上传文件的总大小上限 |
| `RESULT_TTL_SECONDS` | No | `300` | 临时结果存活秒数 |
| `RESULT_STORAGE_MAX_SIZE` | No | `256MB` | 临时结果总存储上限 |
| `RESULT_STORAGE_DIR` | No | 系统临时目录下的 `image-compress-api-results` | 临时结果落盘目录；Docker 内默认对应 `/tmp/image-compress-api-results` |

说明：

- `UPLOAD_*` 限制的是“客户端发进来的请求体”
- `RESULT_STORAGE_MAX_SIZE` 限制的是“服务端临时结果目录最多能占多少磁盘”
- 这两类限制互相独立，分别控制入口流量和服务端临时存储

Token 使用建议：

- 按调用方分配独立 Token，避免多人共享同一个密钥
- 某个 Token 泄露时，只撤销该 Token，不影响其他调用方

## API Contract

完整 OpenAPI 见 `openapi.yaml`。

### 1) Create Result

`POST /api/image-compress/v1/compress`

Headers：

- `Authorization: Bearer <token>`

Content-Type：

- `multipart/form-data`

Form Fields：

- `files` (required, repeatable)
- `zipName` (optional, 仅多图时影响 ZIP 文件名)

说明：

- 旧参数 `quality` / `targetFormat` / `output` 仍不支持

Success JSON 示例：

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
  "download": {
    "url": "http://127.0.0.1:3001/api/image-compress/v1/results/9f3a7d4e-1234-5678-9abc-def012345678?token=example_token",
    "expiresAt": "2026-03-07T16:00:00.000Z",
    "singleUse": true
  },
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

字段说明：

- `success=true` 只表示请求被成功处理
- `compressed` / `outcome` 表示最终响应是否保留了处理后的产物
- 如果某图再编码后不更小，则会回退原图，表现为 `outcome=fallback_original`
- `compressionRatio` 是节省比例的小数值，不是百分数字符串
- `download.url` 指向这次压缩生成的临时结果，不需要重新压缩
- `originalFileName` / `outputFileName` 默认保留原始 Unicode 文件名；下载响应使用 `Content-Disposition` 的 `filename*` 返回 UTF-8 文件名

### 2) Download Result

`GET /api/image-compress/v1/results/:resultId?token=...`

说明：

- 这是一次性下载 URL
- 下载成功后，服务端会删除对应临时资源
- 如果资源已过期、已被消费、ID 不存在或 token 不匹配，返回 `404 NOT_FOUND`
- 下载接口不需要 `Authorization`，因为 URL 自带一次性签名 token
- 下载响应会同时返回 ASCII fallback 的 `filename` 和 UTF-8 的 `filename*`

返回规则：

- 单图：返回图片二进制
- 多图：返回 `application/zip`

### Error JSON

```json
{
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "files is required"
  }
}
```

### Error Codes

- `400 INVALID_ARGUMENT`
- `401 UNAUTHORIZED`
- `404 NOT_FOUND`
- `413 PAYLOAD_TOO_LARGE`
- `415 UNSUPPORTED_MEDIA_TYPE`
- `422 PROCESSING_FAILED`
- `500 INTERNAL_ERROR`
- `507 INSUFFICIENT_STORAGE`

## cURL Examples

建议先从 `.env` 读取一个 Token：

```bash
TOKEN="$(grep '^IMAGE_COMPRESS_API_TOKENS=' .env | cut -d= -f2- | cut -d, -f1)"
```

### 1) 上传并获取 metadata

```bash
curl -X POST "http://127.0.0.1:3001/api/image-compress/v1/compress" \
  -H "Authorization: Bearer ${TOKEN}" \
  -F "files=@/path/to/demo.jpg"
```

### 2) 提取 `download.url` 并下载

使用 `jq`：

```bash
RESPONSE_JSON="$(curl -sS -X POST "http://127.0.0.1:3001/api/image-compress/v1/compress" \
  -H "Authorization: Bearer ${TOKEN}" \
  -F "files=@/path/to/demo.jpg")"

echo "${RESPONSE_JSON}" | jq .

DOWNLOAD_URL="$(echo "${RESPONSE_JSON}" | jq -r '.download.url')"
OUTPUT_FILE_NAME="$(echo "${RESPONSE_JSON}" | jq -r '.outputFileName')"
curl -fL "${DOWNLOAD_URL}" -o "${OUTPUT_FILE_NAME}"
```

说明：

- `outputFileName` 是服务端返回的规范文件名；如果你要保留中文文件名，命令行里优先用 `-o "${OUTPUT_FILE_NAME}"`
- `curl -OJ` 依赖客户端自己解析 `Content-Disposition`；部分客户端只会采用 ASCII fallback 文件名，不一定保留中文
- `-f` 会让 `404` / `500` 之类的错误直接失败，避免把错误 JSON 保存成一个“看起来像文件”的输出

如果没有 `jq`，也可以先手动复制 JSON 里的 `download.url` 和 `outputFileName` 再下载。

### 3) 多图上传，结果为 ZIP

```bash
curl -X POST "http://127.0.0.1:3001/api/image-compress/v1/compress" \
  -H "Authorization: Bearer ${TOKEN}" \
  -F "files=@/path/to/a.jpg" \
  -F "files=@/path/to/b.png" \
  -F "zipName=my_batch"
```

## Resource Lifecycle

- 压缩成功后，服务会把最终产物落到临时目录
- JSON metadata 会带回一次性 `download.url`
- 客户端成功下载后，服务会删除该产物
- 如果客户端下载中断，资源会保留到 TTL 到期，再由清理逻辑回收
- 如果临时结果总大小超过 `RESULT_STORAGE_MAX_SIZE`，新请求会返回 `507 INSUFFICIENT_STORAGE`

## Testing Checklist

```bash
npm run check
npm test
npm run build
```

手动验证建议覆盖：

- Token 缺失 / 错误（应返回 `401`）
- 上传旧参数 `quality/targetFormat/output`（应返回 `400`）
- 上传非 `jpg/png/webp`（应返回 `415`）
- 上传不可解码文件（应返回 `422`）
- 上传带 EXIF Orientation 的图片：若旋转归一化后体积略增，仍应保留旋转后的输出
- 多图上传时，metadata 返回 ZIP 信息且下载 URL 返回 ZIP
- 单次下载成功后再次访问同一 `download.url`（应返回 `404`）
- TTL 过期后的下载 URL（应返回 `404`）
- 临时存储上限打满时（应返回 `507`）

补充：

- 仓库内的 `test_images/` 会参与真实样本回归，覆盖支持格式与不支持格式
- 如果本地刻意删除了该目录，相关测试会自动跳过，避免阻塞基础 CI

## Directory Structure

说明：

- `local-docs/`：本地进度与临时文档目录，默认已在 `.gitignore` 中忽略，不会提交到仓库。

```text
.
├── .env.example
├── Dockerfile
├── README.md
├── openapi.yaml
├── package.json
├── src
│   ├── lib
│   │   ├── auth.ts           # Bearer Token 鉴权
│   │   ├── compress.ts       # Sharp 压缩主逻辑
│   │   ├── result-store.ts   # 临时结果存储、TTL、一次性下载控制
│   │   ├── validate.ts       # 上传限制与文件名规范化
│   │   └── zip.ts            # ZIP 归档生成
│   ├── routes
│   │   ├── compress.ts       # POST /api/image-compress/v1/compress
│   │   └── results.ts        # GET /api/image-compress/v1/results/:resultId
│   ├── server.ts             # Fastify 启动与全局错误处理
│   └── types
│       └── api.ts            # 公共类型与 HttpError
├── test_images               # 仓库内真实样本 fixture（jpg/png/webp/svg）
├── tests
│   └── compress.test.ts
└── local-docs
    └── plan
        └── ephemeral-result-resource.md
```
