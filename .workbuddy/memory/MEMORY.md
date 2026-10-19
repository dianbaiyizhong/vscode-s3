# vscode-s3 项目约定

## 完成代码修改后必须自动打包
- 用户要求：每次回答完成前，若本轮修改了代码/配置，自动运行 `npx --yes @vscode/vsce package --allow-missing-repository` 生成 vsix（--allow-missing-repository 必须带，因为 package.json 里的 repository 是占位地址）。
- 产物：`vscode-s3-<version>.vsix`，直接覆盖旧版本文件。

## 其他项目事实
- 连接信息/跳转历史/收藏存在 VSCode globalState（state.vscdb），键名 s3Connections / jumpHistory / jumpBookmarks；密钥为明文存储。
- tsc --noEmit 有约 49 个历史遗留类型错误，属正常基线；以"错误数不增加"为回归标准。
- i18n 双语（en/zh-cn）都在 src/i18n.ts 内；命令标题需同步维护 package.nls.json 和 package.nls.zh-cn.json。
