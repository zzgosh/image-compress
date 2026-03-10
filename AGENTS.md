# Repository Guidelines

## Project Structure & Module Organization

这是一个基于 Node.js 20、TypeScript 和 Fastify 的图片压缩 API。核心代码在 `src/`：`src/routes/` 放 HTTP 路由，`src/lib/` 放压缩、鉴权、暂存和 ZIP 逻辑，`src/types/` 放共享类型。测试在 `tests/`，真实图片夹具在 `test_images/`。`openapi.yaml` 是对外 API 合约，`dist/` 是构建产物，不要手改。

## Build, Test, and Development Commands

- `npm install`：安装依赖。
- `npm run dev`：用 `tsx watch` 启动本地开发服务，自动读取 `.env`。
- `npm run check`：执行 TypeScript 类型检查，不产出文件。
- `npm run build`：编译到 `dist/`。
- `npm test`：运行 Node 内置测试（当前入口为 `tests/compress.test.ts`）。
- `npm run start`：运行已构建的 `dist/server.js`。

本地调试前先复制 `.env.example` 到 `.env` 并填写 `IMAGE_COMPRESS_API_TOKENS`。

## Coding Style & Naming Conventions

沿用现有 TypeScript ESM 风格、2 空格缩进和 `strict` 模式约束。变量与函数使用 `camelCase`，类使用 `PascalCase`，常量使用全大写或语义化对象键名。新增路由文件优先按端点命名，例如 `src/routes/results.ts`。公共 API 字段、OpenAPI schema 和环境变量名保持 ASCII English；工程说明、注释和文档使用简体中文。

## Testing Guidelines

测试框架使用 `node:test` 和 `assert/strict`。新增测试放在 `tests/*.test.ts`，文件名应与被验证模块或行为对应。涉及压缩结果、文件名、MIME 或下载流程的改动，至少补一条成功路径和一条边界/失败路径；需要真实输入时复用 `test_images/` 夹具，不要引入大体积样本。

## Commit & Pull Request Guidelines

提交历史采用 Conventional Commits，类型前缀用英文，主题用简体中文，例如 `fix: 收紧临时结果存储目录清理与并发配额`。开始修改前请从 `main` 切出功能分支，例如 `git checkout -b feat/update-download-flow`。PR 应说明变更目的、接口或环境变量影响、验证命令与结果；如果修改了下载行为或响应结构，附上 `curl` 示例或 JSON 片段。无关重构、格式化或依赖升级请分开提交。

## Security & Configuration Tips

`.env`、临时目录和 Token 不要提交。`local-docs/` 仅放本地过程文档，保持未跟踪。修改上传大小、结果 TTL 或存储上限时，同时更新 `README.md`、`.env.example` 和 `openapi.yaml`，避免实现与文档漂移。新增接口或响应字段时，先改合约再改实现，确保 `openapi.yaml`、`src/types/api.ts` 和路由返回值一致。
