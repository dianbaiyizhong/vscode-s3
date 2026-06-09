# S3 Browser for VS Code

> 在 VS Code 中直接浏览和管理任意 S3 兼容的对象存储 | Browse and manage any S3-compatible object storage directly inside VS Code

![VS Code](https://img.shields.io/badge/VS_Code-1.85%2B-007ACC?logo=visual-studio-code)
![License](https://img.shields.io/badge/license-MIT-green)

---

## ✨ Features | 特性

| | Feature | Description |
|---|---|---|
| 🔗 | **Multi-connection** | 添加多个 S3 连接，支持任意 S3 兼容服务 |
| 🔐 | **Secure Storage** | AK/SK 通过 VS Code SecretStorage 加密存储 |
| 📂 | **Tree View** | 三级树结构浏览：连接 → 文件夹 → 文件 |
| ⬆️ | **Upload** | 右键文件夹/连接根，上传文件到当前路径 |
| ⬇️ | **Download** | 右键文件，保存到本地 |
| 🗑️ | **Delete** | 删除文件或递归删除文件夹 |
| ✏️ | **Edit** | 编辑已有连接的参数 |
| 🧪 | **Test Connection** | 添加/编辑连接时可选测试连通性 |

---

## 📦 Installation | 安装

### 方法一：直接安装 VSIX（推荐）

```bash
# 下载最新版 .vsix 后执行
code --install-extension vscode-s3-1.0.0.vsix --force
```

或：VS Code → 左侧 Extensions `Ctrl+Shift+X` → `...` → `Install from VSIX...` → 选择 `.vsix` 文件

### 方法二：从源码构建

```bash
git clone https://github.com/your-username/vscode-s3.git
cd vscode-s3
npm install --cache /tmp/npm-cache
npm run compile
npx vsce package
code --install-extension vscode-s3-1.0.0.vsix --force
```

---

## 🚀 Quick Start | 快速上手

1. 安装后，左侧 Activity Bar 出现 **S3** 图标，点击进入
2. 点击视图标题栏的 `+` 按钮 → **Add S3 Connection...**
3. 按提示依次输入：

| Field | Example | Description |
|---|---|---|
| Connection Name | `My MinIO` | 连接别名 |
| Endpoint | `http://localhost:9000` | S3 服务地址 |
| Region | `us-east-1` | 区域（大部分非 AWS 服务填任意值） |
| Bucket | `my-bucket` | 桶名称 |
| Path Style? | Yes / No | MinIO/Ceph 选 Yes，AWS S3 选 No |
| Access Key ID | `admin` | 访问密钥 ID |
| Secret Access Key | `password` | 访问密钥（会加密存储） |

4. 连接成功 → 展开连接查看文件列表
5. **上传**：右键文件夹 → Upload File
6. **下载**：右键文件 → Download
7. **删除**：右键文件/文件夹 → Delete

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

- **Access Key / Secret Key** 使用 VS Code 的 [`SecretStorage`](https://code.visualstudio.com/api/references/vscode-api#SecretStorage) 加密存储，不会以明文写入配置文件
- 连接元数据（endpoint、bucket、region 等）存储在 `globalState` 中
- 所有 S3 API 请求直接从 VS Code 发出，不经第三方代理

---

## 🛠 Development | 开发

```bash
# 安装依赖
npm install --cache /tmp/npm-cache

# 开发构建
npm run compile

# 启动调试（F5）
# 在 VS Code 中按 F5 打开 Extension Development Host

# 打包
npx vsce package
```

### 项目结构

```
vscode-s3/
├── src/
│   ├── extension.ts          # 入口：激活、注册视图和命令
│   ├── connectionManager.ts  # 连接 CRUD，AK/SK 存入 SecretStorage
│   ├── s3Client.ts           # S3 API 封装（List/Upload/Download/Delete）
│   ├── treeView.ts           # TreeDataProvider + S3TreeItem
│   └── commands.ts           # 所有命令处理器
├── scripts/build.js          # esbuild 构建脚本
├── resources/icon.svg        # Activity Bar 图标
└── package.json              # 扩展清单
```

---

## 📄 License

MIT

---

## 🤝 Contributing

Issues and PRs are welcome!

如果你觉得好用，请给一个 ⭐ Star 让更多人看到！
