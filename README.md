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

### 桌面版（Windows / macOS / Linux App，推荐）

桌面版的 `desktop` profile 由 Electron 应用独占，命令行无法管理它，**请用界面安装**：

1. 打开 DSH → **设置** → **插件** → **添加插件**
2. 安装方式选 **Git**，把下面这一整行粘进输入框（不要带尖括号、不要带中文说明）：

   ```
   https://github.com/nuclearmilk/dsh-hud
   ```

3. 点 **安装**，等进度跑完
4. **重启 DSH**（气泡是独立 Electron 进程，由宿主插件在启动时拉起）
5. 设置侧栏出现 **「任务通知流HUD」** 页 = 装好了

想钉死版本（推荐写进 issue、教程、给别人复现时用）——用 tag 或 commit hash：

```
https://github.com/nuclearmilk/dsh-hud#v1.1.0
```

```
https://github.com/nuclearmilk/dsh-hud#<commit hash，从 Commits 页复制>
```

`#` 后面不写也可以，那就是装默认分支最新代码，适合自己追踪开发版。

### 命令行（仅非 `desktop` profile，例如 `tui`）

`dsh plugin` 会把参数原样转发给 pnpm，`--profile` 是**必填**参数：

```sh
dsh plugin --profile tui add https://github.com/nuclearmilk/dsh-hud
```

对 `desktop` 执行这条会直接报错，这是设计如此：

```
error: profile "desktop" is managed exclusively by the Electron application
```

### 已在本地改代码时（link 方式）

不想每次改都重装，就把 profile 里的依赖指到本地目录，改完重启 DSH 即可：

```sh
dsh plugin --profile tui add link:/path/to/dsh-hud
```

## 更新与卸载

| 操作 | 做法 |
| --- | --- |
| 更新（Git / link 安装） | 界面里先卸载再装一次；link 方式直接 `git pull` 后重启 DSH |
| 更新（npm 安装） | 插件列表里点 **Update**（仅官方按需插件提供显式更新） |
| 卸载 | 设置 → 插件 → 选中 `dsh-hud` → 卸载 → 重启 DSH |

## 装不上或有界面没气泡

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 安装时提示 spec 无效 | 输入框里留了模板文本 | 只保留 `https://github.com/nuclearmilk/dsh-hud` |
| `could not read Username` / 403 | 仓库不可公开访问 | 必须用公开仓库；私有仓库的 git 安装需要配置凭据 |
| 升级到 1.1.0 后出现两个气泡窗口 | 旧版本 spawn 的独立窗口还没退 | 新版本会自动向旧实例发 `/api/quit`；若仍在，结束任务管理器里的 `electron.exe` 后重启 DSH |
| 设置里有页面，但屏幕上没有气泡 | 极少数情况下宿主不是 Electron（CLI / web profile） | 见下一节；桌面版不需要处理 |
| 设置了透明度/主题但没变化 | 桌面窗口没起来，改的是配置不是画面 | 同上 |

## 运行方式：默认零依赖

**桌面版什么都不用装。**桌面宿主本身就是 Electron，而插件由宿主的 cordis loader 在其主进程内加载，所以气泡窗口直接在本进程里创建（`lib/inprocess.js`）：不 spawn 任何外部进程、不依赖 Electron 包、也不依赖任何其他插件。

只有一种情况会走回退路径：宿主不是 Electron（例如 `dsh --profile tui`、纯 Node 部署）。这时 `lib/index.js` 才去 spawn `runtime/main.js`，并按以下顺序找 Electron 可执行文件：

1. 环境变量 `DSH_HUD_ELECTRON` 指定的路径
2. `~/.dsh/electron/`（例如 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 自动下载的共享运行时）
3. 当前 DSH profile 的 `node_modules/electron/dist/`（含 pnpm 的 `.pnpm` 软链布局）
4. 本插件包自身的 `node_modules/electron/dist/`
5. 仅当宿主进程本身就是 `electron.exe` 时才复用 `process.execPath`

都找不到时插件不会报错，DSH 照常运行，只是不会出现桌面气泡；插件日志会打印一条 `WARN` 说明原因。

回退路径的三种补齐方式，任选其一：

```powershell
# A. 显式指定（最直接）
$env:DSH_HUD_ELECTRON = "C:\path\to\electron.exe"

# B. 放一个共享运行时到这个约定目录，所有插件共用
#    ~/.dsh/electron/electron.exe      （Windows）
#    ~/.dsh/electron/electron          （macOS / Linux）

# C. 装 dsh-pet，它会自动下载共享运行时到 ~/.dsh/electron
```

## 数据与隐私

- 配置保存在 Electron 的 `userData` 目录下（`dsh-hud-config.json`），不写入插件包目录
- 不联网、不上报：全部事件来自本机 DSH 的 `session/event`，气泡数据只在本机进程间流转
- 本地控制接口仅监听 `127.0.0.1:52399`

## 架构

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 宿主插件 | `lib/index.js` | 声明 `dsh.bundle`，监听 `session/event`，暴露 `/dsh-hud/state` |
| 进程内窗口 | `lib/inprocess.js` | **桌面版默认路径**：在宿主 Electron 主进程内创建透明置顶窗，事件直接 `webContents.send`，不经过 HTTP |
| 配置前端 | `lib/client.js` | 在 `settings.section` 注册设置页 |
| 独立窗口（回退） | `runtime/main.js` · `runtime/index.html` | 宿主不是 Electron 时，spawn 出来的独立透明窗口；渲染与拖拽代码与进程内路径共用 |

## 协议

MIT
