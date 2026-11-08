# dsh-hud · 任务通知流HUD

为 **DeepSeek Harness** 打造的屏幕贴边任务通知流。群唱（Cappella）风格的水润毛玻璃气泡会在屏幕边缘实时浮出，汇报 `THINKING` / `WORKING` / `STEP DONE` / `COMPLETED` 四类进度，像聊天一样陪着你干活。

## 特性

- 🫧 **Cappella 水润毛玻璃**：高斯模糊 + 内发光边框，通透不糊字
- 🎨 **明暗双主题**：☀️ 纯净白色毛玻璃 / 🌙 深邃暗色磨砂
- 🎚️ **无级透明度**：20% ~ 100% 拖动实时生效
- ✋ **自由拖拽并记忆位置**：移动模式随手拖，锁定后坐标不回弹
- 🎭 **个性化头像**：莫奈渐变、纯色（选色轮盘 / 直接输入 `#8b5cf6`）、本地图片上传
- 🔤 **系统字体全量检索**：自动读取本机已安装字体，切换即时生效
- 💬 **左右分边或整齐靠右**：`allRight` 关闭时气泡左右交替弹出，模拟对话节奏
- ⚡ **四态精细化**：`THINKING` 7 秒自动淡出，`WORKING` 全程常驻，`STEP DONE` 短句小结，`COMPLETED` 输出摘要

## 安装

```sh
dsh plugin add <本仓库路径或 Git 地址>
```

安装后重启 DSH，设置侧栏会出现独立的 **「任务通知流HUD」** 页面。

## 运行依赖：Electron 运行时

桌面气泡是一个独立的透明 Electron 窗口，因此本机需要有一个可用的 Electron 可执行文件。插件按以下顺序自动查找：

1. 环境变量 `DSH_HUD_ELECTRON` 指定的路径
2. `~/.dsh/electron/`（例如 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 自动下载的共享运行时）
3. 当前 DSH profile 的 `node_modules/electron/dist/`
4. 本插件包自身的 `node_modules/electron/dist/`

都找不到时插件不会报错，DSH 照常运行，只是不会出现桌面气泡；设置页会显示一条橙色提示说明原因。

显式指定路径的示例：

```powershell
$env:DSH_HUD_ELECTRON = "C:\path\to\electron.exe"
```

## 数据与隐私

- 配置保存在 Electron 的 `userData` 目录下（`dsh-hud-config.json`），不写入插件包目录
- 不联网、不上报：全部事件来自本机 DSH 的 `session/event`，气泡数据只在本机进程间流转
- 本地控制接口仅监听 `127.0.0.1:52399`

## 架构

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 宿主插件 | `lib/index.js` | 声明 `dsh.bundle`，监听 `session/event`，暴露 `/dsh-hud/state`，拉起桌面窗口 |
| 配置前端 | `lib/client.js` | 在 `settings.section` 注册设置页 |
| 桌面视窗 | `runtime/main.js` · `runtime/index.html` | 透明置顶窗口、气泡渲染与拖拽 |

## 协议

MIT
