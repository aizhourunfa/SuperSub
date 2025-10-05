# SuperSub - 智能订阅转换与管理平台

SuperSub 是一个构建在 Cloudflare 生态系统上的全栈应用程序，旨在提供强大而灵活的代理订阅转换和管理功能。它允许用户聚合、处理和分发适用于不同客户端的定制化配置文件。

## ✨ 核心功能

- **多协议支持**：通过灵活的节点解析器，支持从各种订阅源导入不同协议的节点。
- **订阅管理**：轻松添加、管理和更新多个远程订阅源。
- **规则驱动的转换**：创建和管理订阅规则，以过滤、排序和重命名节点。
- **可定制的配置模板**：为不同的代理客户端（如 Clash）创建和管理输出模板。
- **流水线处理**：将订阅、规则和模板组合成强大的处理流水线，生成最终的客户端配置文件。
- **健康检查**：监控节点状态，确保可用性。
- **用户认证**：安全的 JWT 用户认证系统。

## 🚀 技术栈

- **前端**：
  - [Vue 3](https://vuejs.org/) (Composition API)
  - [Vite](https://vitejs.dev/)
  - [Naive UI](https://www.naiveui.com/)
  - [Pinia](https://pinia.vuejs.org/)
  - [Tailwind CSS](https://tailwindcss.com/)
- **后端**：
  - [Cloudflare Workers](https://workers.cloudflare.com/)
  - [Hono](https://hono.dev/)
- **数据库**：
  - [Cloudflare D1](https://developers.cloudflare.com/d1/)
- **部署**：
  - [Cloudflare Pages](https://pages.cloudflare.com/)

## 🛠️ 本地开发

### 1. 先决条件

- [Node.js](https://nodejs.org/) (>= 18.0.0)
- [npm](https://www.npmjs.com/)

### 2. 安装依赖

克隆项目后，在根目录运行：
```bash
npm install
```

### 3. 初始化数据库

首次运行时，或当数据库结构发生变化时，需要初始化本地 D1 数据库。
```bash
npm run db:init
```
如果遇到数据库相关的错误 (例如 `no such table`)，可以尝试硬重置：
```bash
# 删除旧的 Wrangler 状态 (包括 D1 数据库)
rm -rf .wrangler
# 重新初始化
npm run db:init
```

### 4. 启动开发服务

为了确保稳定，推荐在两个独立的终端中分别启动后端和前端。

**- 终端 1: 启动后端 (Wrangler)**
```bash
npm run start:backend
```
等待直到您看到 `[wrangler] Ready on http://localhost:8789` 的输出。

**- 终端 2: 启动前端 (Vite)**
```bash
npm run start:frontend
```
前端服务启动后，您可以在浏览器中访问 `http://localhost:5173`。

Vite 会自动将 `/api` 请求代理到运行在 `8789` 端口的后端服务。

## 📜 主要 NPM 脚本

- `npm run start:frontend`: 仅启动 Vite 前端开发服务器。
- `npm run start:backend`: 仅启动 Wrangler 后端开发服务器。
- `npm run db:init`: 初始化本地 D1 数据库。
- `npm run build`: 构建用于生产环境的前端应用。
