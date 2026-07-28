# VortexDown - NAS 视频下载器 (Docker 版)

一个轻量级的 NAS 视频下载器，支持 M3U8/MPD/ISM/HTTP 直链下载，自带文件命名、批量下载、并发控制等功能。专为 fnOS 等 NAS 系统的 Docker 环境设计。

## 功能特性

- **多格式支持**：M3U8、MPD (DASH)、ISM (Smooth Streaming)、HTTP 直链 (mp4/mkv/ts 等)
- **智能命名**：模板化文件名生成，支持剧名、季、集数、标题等变量
- **批量下载**：支持多行链接粘贴，自动识别集数
- **并发控制**：可配置最大同时下载数和 M3U8 分片并发数
- **进度追踪**：实时显示下载进度、速度、已下载大小
- **断点续传**：HTTP 直链支持 Range 续传
- **AES-128 解密**：自动解析 M3U8 加密密钥并解密
- **零依赖**：Node.js 纯 ESM 实现，无需 npm install
- **Docker 部署**：一键拉取镜像，数据持久化，开箱即用

## 快速开始

### 方式一：直接拉取镜像（推荐）

```bash
docker run -d \
  --name vortexdown \
  --restart unless-stopped \
  -p 19634:19634 \
  -v /vol1/1000/vortexdown/downloads:/downloads \
  -v /vol1/1000/vortexdown/data:/app/data \
  -v /vol1/1000:/host:ro \
  -e TZ=Asia/Shanghai \
  -e BROWSE_ROOTS=/downloads,/host \
  ghcr.io/<你的GitHub用户名>/vortexdown:latest
```

### 方式二：docker-compose 部署

1. 下载 `docker-compose.yml`
2. 修改挂载路径为你 NAS 的实际路径
3. 启动：

```bash
docker-compose up -d
```

### 方式三：本地构建

```bash
git clone https://github.com/<你的GitHub用户名>/vortexdown.git
cd vortexdown
docker-compose up -d --build
```

## 访问

启动后访问：`http://<NAS的IP>:19634`

## 配置说明

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `19634` | 服务端口 |
| `TZ` | `Asia/Shanghai` | 时区 |
| `DOWNLOAD_DIR` | `/downloads` | 默认下载目录 |
| `DATA_DIR` | `/app/data` | 数据目录（任务记录、设置） |
| `BROWSE_ROOTS` | `/downloads,/host` | 文件浏览根路径（逗号分隔） |

### 卷挂载

| 容器路径 | 说明 |
|----------|------|
| `/downloads` | 下载文件保存目录（必须可写） |
| `/app/data` | 任务记录和设置（必须可写） |
| `/host` | 宿主机文件系统（只读，用于浏览选择保存路径） |

### fnOS 挂载路径参考

fnOS 的用户数据通常在 `/vol1/1000/` 下：

```yaml
volumes:
  - /vol1/1000/vortexdown/downloads:/downloads
  - /vol1/1000/vortexdown/data:/app/data
  - /vol1/1000:/host:ro
```

## 使用说明

### 基本使用

1. 打开 Web 界面
2. 在「下载根目录」选择保存路径
3. 输入剧名（如：`金特务`）
4. 填写季数（如：`1`）
5. 粘贴视频链接（每行一个）
6. 点击「开始批量下载」

### 链接格式支持

- 纯 URL：`https://example.com/video/01.m3u8`
- 名称 + URL：`第01集 https://example.com/video/01.mp4`
- $ 分隔符：`第01集$https://example.com/video/01.mp4`
- 反引号包裹：`第01集$\`https://example.com/video/01.mp4\`：本色回归 01.mp4`

### 文件命名模板

| 变量 | 说明 | 示例 |
|------|------|------|
| `{name}` | 剧名 | 金特务 |
| `{season}` | 季数（两位） | 01 |
| `{s}` | 季数（简写） | 1 |
| `{episode}` | 集数（两位） | 01 |
| `{e}` | 集数（简写） | 1 |
| `{ep_title}` | 集标题 | 第01集 |
| `{ext}` | 扩展名 | mp4 |
| `{date}` | 日期 | 20260728 |
| `{original}` | 原始文件名 | video_01 |

默认模板：`{name} S{season}E{episode}.{ext}`

### 文件保存结构

```
/downloads/
  └── 金特务/                    # 以剧名创建子文件夹
      ├── 金特务 S01E01.mp4
      ├── 金特务 S01E02.mp4
      └── ...
```

## 技术栈

- **后端**：Node.js 20 (纯 ESM，零依赖)
- **下载引擎**：
  - HTTP 直链：Node.js 原生 http/https 模块
  - M3U8/MPD/ISM：N_m3u8DL-RE (内置)
  - M3U8 备用引擎：Node.js 原生实现 + ffmpeg 合并
- **前端**：原生 HTML/CSS/JavaScript
- **容器**：Docker (node:20-slim + ffmpeg)

## GitHub 自动构建

项目内置 GitHub Actions 工作流，推送到 main 分支或创建 `v*` 标签时会自动构建并推送镜像到 GitHub Container Registry (ghcr.io)。

1. 将代码推送到 GitHub 仓库
2. 在仓库 Settings → Actions → General 中确保 Workflow permissions 为 Read and write
3. 推送代码后自动构建
4. 镜像地址：`ghcr.io/<用户名>/<仓库名>:latest`

## 许可证

MIT License
