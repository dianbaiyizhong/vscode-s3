# S3 Browser for VS Code

> 在 VS Code 中直接浏览和管理任意 S3 兼容的对象存储 | Browse and manage any S3-compatible object storage directly inside VS Code

![VS Code](https://img.shields.io/badge/VS_Code-1.89%2B-007ACC?logo=visual-studio-code)
![License](https://img.shields.io/badge/license-MIT-green)

---

## ✨ Features | 特性

| | Feature | Description |
|---|---|---|
| 🔗 | **Multi-connection** | 添加多个 S3 连接，支持任意 S3 兼容服务 |
| 🔐 | **Secure Storage** | AK/SK 通过 VS Code SecretStorage 加密存储 |
| 📂 | **Tree View** | 树结构浏览所有连接和桶，每项内联操作按钮 |
| 🖥️ | **Folder Browser** | Webview 可视化浏览目录，路径输入框支持前缀/模糊搜索 |
| ⬆️ | **Upload** | 按钮上传，或从系统拖拽文件到目标目录 |
| ⬇️ | **Download** | 下载文件，支持批量多选下载 |
| 👁️ | **Preview & Edit** | 文本文件可在线编辑，保存自动同步回 S3 |
| ✏️ | **Rename** | 内联重命名文件和文件夹 |
| 📁 | **New Folder** | 在任意路径下创建新文件夹 |
| 🔗 | **Copy Path** | 复制 S3 Key 到剪贴板 |
| 🗑️ | **Delete** | 删除文件或递归删除文件夹，支持多选 |
| 📍 | **Jump History** | 自动记录导航历史，路径输入框下拉快速回跳，支持前缀/模糊搜索 |
| 📊 | **Bucket Info** | 一键查看桶的对象总数和总大小 |
| ⚙️ | **Manage Connections** | 添加、编辑、删除连接，支持连通性测试 |
| 🌐 | **i18n** | 中英文自动切换（跟随 VS Code 显示语言） |
| 🔄 | **Refresh** | 一键刷新当前视图 |

---

## 📦 Installation | 安装

### VSIX 安装（推荐）

```bash
code --install-extension vscode-s3-1.0.0.vsix --force
```

或：VS Code → Extensions `Ctrl+Shift+X` → `...` → `Install from VSIX...`

### 从源码构建

```bash
git clone https://github.com/your-username/vscode-s3.git
cd vscode-s3
npm install
npm run compile
npx vsce package
code --install-extension vscode-s3-*.vsix --force
```

---

## 🚀 Quick Start | 快速上手

1. 安装后，左侧 Activity Bar 出现 **S3** 图标，点击进入
2. 点击视图标题栏的 `+` 按钮添加连接
3. 按提示依次输入必要信息：
   - **Connection Name** — 连接别名
   - **Endpoint** — S3 服务地址（如 `http://localhost:9000`）
   - **Region** — 区域（非 AWS 填任意值）
   - **Bucket** — 桶名称
   - **Access Key / Secret Key** — 凭据（加密存储）
4. 点击连接名旁的 `Bucket Info` 按钮查看桶概况
5. 点击连接进入文件浏览器：
   - 路径输入框支持下拉历史回跳
   - 搜索栏可选"前缀"（服务端过滤，快速）或"模糊"（客户端匹配）
   - 列表表头列宽可拖拽调整

---

## 🔧 Supported Services | 支持服务

| Service | Endpoint Example | Path Style |
|---|---|---|
| **AWS S3** | `https://s3.ap-northeast-1.amazonaws.com` | No |
| **MinIO** | `http://localhost:9000` | Yes |
| **阿里云 OSS** | `https://oss-cn-hangzhou.aliyuncs.com` | No |
| **腾讯云 COS** | `https://cos.ap-guangzhou.myqcloud.com` | No |
| **华为云 OBS** | `https://obs.cn-north-4.myhuaweicloud.com` | No |
| **七牛 Kodo** | `https://s3-cn-east-1.qiniucs.com` | No |
| **Ceph RGW** | `http://ceph-radosgw:7480` | Yes |
| **DigitalOcean Spaces** | `https://nyc3.digitaloceanspaces.com` | No |
| **Cloudflare R2** | `https://<account>.r2.cloudflarestorage.com` | No |
| **Backblaze B2** | `https://s3.us-west-004.backblazeb2.com` | No |
| **Wasabi** | `https://s3.us-east-2.wasabisys.com` | No |

---

## 🔒 Security | 安全

- **Access Key / Secret Key** 使用 VS Code [`SecretStorage`](https://code.visualstudio.com/api/references/vscode-api#SecretStorage) 加密存储
- 连接元数据（endpoint、bucket、region 等）存储在 `globalState`
- 所有 S3 API 请求直接从 VS Code 发出，不经第三方代理

---

## 🛠 Development | 开发

```bash
npm install        # 安装依赖
npm run compile    # 构建
npm run watch      # 开发模式自动构建

# 启动调试：VS Code 中按 F5

# 打包
npm run compile && npx vsce package
```

### 自定义图标

图标均为 SVG 文件，直接替换即可：

| 位置 | 说明 |
|---|---|
| `resources/folder.svg` | 文件夹图标 |
| `resources/file.svg` | 文件默认图标 |
| `resources/file-icons/*.svg` | 按后缀名匹配（如 `js.svg`） |
| `resources/action-icons/*.svg` | 操作按钮图标（refresh、upload、back、info、rename、delete、download、copyPath） |

### 项目结构

```
vscode-s3/
├── src/
│   ├── extension.ts          # 入口：激活、创建视图
│   ├── connectionManager.ts  # 连接 CRUD，AK/SK 加密存储
│   ├── s3Client.ts           # S3 API 封装
│   ├── treeView.ts           # 侧边栏树视图
│   ├── folderBrowserPanel.ts # 目录浏览面板（核心 UI）
│   ├── jumpHistory.ts        # 跳转历史记录
│   ├── commands.ts           # 所有命令处理器
│   ├── previewManager.ts     # 文件预览和编辑同步
│   └── i18n.ts               # 中英文国际化
├── resources/
│   ├── folder.svg
│   ├── file.svg
│   ├── file-icons/           # 文件后缀图标
│   ├── action-icons/         # 操作按钮图标
│   └── icon.svg              # Activity Bar 图标
└── scripts/build.js          # esbuild 构建脚本
```

---

## 📄 License

MIT

---

## 🤝 Contributing

Issues and PRs are welcome!

如果你觉得好用，请给一个 ⭐ Star 让更多人看到！