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
- ⏳ **常驻「进行中」气泡**：本轮没结束就一直挂一条 `任务进行中 · 已运行 mm:ss`，长任务不会看起来像已经跑完；设置页可关，**默认开启**

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
https://github.com/nuclearmilk/dsh-hud#v1.4.1
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

## 运行方式：不需要装任何其他东西

桌面版装完即可用，**不需要预先安装 Electron，也不需要 dsh-pet 之类的插件**。缺运行时时插件会自己取一份（首次约 138 MB，之后复用）：

```
[dsh-hud] 未找到 Electron 运行时，正在从 registry.npmmirror.com 获取 electron 43.3.0
[dsh-hud] Electron 运行时下载 20% (27.6/137.7 MB)
...
[dsh-hud] Electron 运行时就绪：~/.dsh/electron/electron.exe
```

- **自动选最快的源**：开跑前对 GitHub、npmmirror、华为云**并行测速**（各取 512 KB，从首字节计时），用测出来的第一名下载，其余按名次兜底。开着代理时通常 GitHub 最快，直连中国大陆时通常镜像最快——不用你手动选
- **指定源**：`DSH_HUD_ELECTRON_MIRROR` 可强制某个镜像排在最前
- **断点续传**：中断后留下 `<包名>.zip.part`，下次从断点继续（换源也能接着下，各源是同一个文件）
- **并发保护**：`.download.lock` 保证多个入口不会重复下载
- **自定义位置**：`DSH_HUD_ELECTRON_DIR` 改存放目录，`DSH_HUD_ELECTRON_VERSION` 改版本

查不到就用现成的，按以下顺序（`lib/index.js` 的 `resolveElectron`）：

1. 环境变量 `DSH_HUD_ELECTRON` 指定的路径
2. 共享运行时目录 `~/.dsh/electron/`（自动下载也放这里，`DSH_HUD_ELECTRON_DIR` 可改）
3. 当前 DSH profile 的 `node_modules/electron/dist/`（含 pnpm 的 `.pnpm` 软链布局）
4. 本插件包自身的 `node_modules/electron/dist/`
5. 仅当宿主进程本身就是 `electron.exe` 时才复用 `process.execPath`

全都拿不到时插件不会报错，DSH 照常运行，只是不会出现桌面气泡；插件日志会打印 `WARN` 说明原因，设置页也会亮橙色提示。

> 为什么不用宿主自带的 Electron：桌面宿主把 dsh runtime 放在 **Node 模式的 Electron 子进程**里加载插件（`ELECTRON_RUN_AS_NODE=1`），那个进程 `require('electron')` 会直接 `MODULE_NOT_FOUND`，拿不到 `BrowserWindow`。所以气泡必须由一份真正的 Electron 运行时来承载。

手动准备运行时（离线机器 / 想自己控制版本）：

```powershell
# A. 显式指定已有 electron
$env:DSH_HUD_ELECTRON = "C:\path\to\electron.exe"

# B. 把运行时放到约定目录，所有插件共用
#    ~/.dsh/electron/electron.exe      （Windows）
#    ~/.dsh/electron/Electron.app/Contents/MacOS/Electron  （macOS）
#    ~/.dsh/electron/electron          （Linux）

# C. 换镜像（国内常见做法）
$env:DSH_HUD_ELECTRON_MIRROR = "https://registry.npmmirror.com/-/binary/electron"
```

## 数据与隐私

- 配置保存在 Electron 的 `userData` 目录下（`dsh-hud-config.json`），不写入插件包目录
- 不联网、不上报：全部事件来自本机 DSH 的 `session/event`，气泡数据只在本机进程间流转
- 本地控制接口仅监听 `127.0.0.1:52399`

## 架构

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 宿主插件 | `lib/index.js` | 声明 `dsh.bundle`，监听 `session/event`，暴露 `/dsh-hud/state` |
| 进程内窗口 | `lib/inprocess.js` | 仅当宿主真在 Electron 主进程里跑插件时启用；当前桌面版宿主是 Node 模式，因此实际不走这条 |
| 配置前端 | `lib/client.js` | 在 `settings.section` 注册设置页 |
| 运行时获取 | `lib/runtime-fetch.js` | 缺 Electron 时自动下载到 `~/.dsh/electron/`（镜像 + 断点续传 + 解压） |
| 独立窗口 | `runtime/main.js` · `runtime/index.html` | 桌面版实际路径：spawn 出来的独立透明窗口，渲染与拖拽都在这里 |

## 协议

MIT
