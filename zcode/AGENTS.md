# 全局默认指令

## 本机软件安装布局（Windows）

大量软件从 C 盘标准路径**镜像安装到 D 盘：子路径不变，仅盘符 C→D**（为节省 C 盘空间）。找文件/程序时，C 盘标准路径不存在就先换 D 盘同路径再找，例如：

- `C:\Program Files\...` → `D:\Program Files\...`（如微信 `D:\Program Files\Tencent\Weixin\Weixin.exe`）
- `C:\Users\Ming\AppData\Local\Programs\...` → `D:\Users\Ming\AppData\Local\Programs\...`（如 ZCode）
- 少数为打包安装，位于 `D:\MyAppPrograms\`（如网易云音乐）

## 拉起桌面程序：按最快路径执行

1. 首选 `open_application`（computer-use）按用户提供的**原始名称**启动；标准安装通常一步成功。
2. 名称启动失败时，**直接查注册表 App Paths 定位真实 exe**（一次 reg query，比翻开始菜单快）：
   ```bash
   reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\<exe名>.exe" 2>/dev/null
   ```
3. 拿到 exe 路径后**不要再传给 open_application**（Windows 启动器只接受名称，传路径必被拒），直接用 Bash 启动：
   ```bash
   cmd //c start "" "<exe路径 或 开始菜单快捷方式.lnk>"
   ```
4. 兜底：搜开始菜单快捷方式，用 `.lnk` 启动：
   ```bash
   find "$APPDATA/Microsoft/Windows/Start Menu/Programs" "C:/ProgramData/Microsoft/Windows/Start Menu/Programs" -iname "*.lnk"
   ```

## 已知实例

- 网易云音乐：App Paths 注册名 `cloudmusic.exe` → `D:\MyAppPrograms\com.tencent.pcgame.cloud.music\cloudmusic.exe`；`open_application` 按名"网易云音乐"/"cloudmusic"均失败，用第 3 步命令秒开。启动后会恢复上次播放状态（自动续播音乐）。

## 本机小坑

- Git Bash 下 PowerShell 单行命令中的 `$_` 会被展开，需写成 `\$_`。
- 网易云音乐界面的无障碍元素暴露极少，按钮级自动化优先走截图+视觉定位。
