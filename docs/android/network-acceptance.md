# 可重复的跨端网络验收

固定 iOS 对照提交 201a87a / 1.4.2 build 10，测试使用 android 分支的未提交实现和独立 Apple 工作目录。不得使用用户线上书库进行该测试。

先运行 build-native.ps1 和 test-device.ps1，生成双 ABI 原生库及独立验收 APK；安装 scripts/requirements-network.txt 中的 Python 测试依赖。Windows 需要已安装的 Chrome、Node 和 Android SDK，Mac 需要 Xcode 及已有的独立 CodexAcceptance 工作目录和专用模拟器。Mac 主机密钥必须已在可信 known_hosts 中，脚本不自动信任新主机。

test-cross-ink-network.py 的参数为 --ssh-host、--ssh-user、--mac-directory、--serial 和新的 --evidence 路径。SSH 密码只通过 SHUFANG_SSH_PASSWORD 环境变量传入，不得写在命令行、源码或报告中。每轮创建隔离账户和资料，Rust 测试服务器仅监听 Windows 回环地址 31487；SSH 反向转发只监听 Mac 回环地址。浏览器使用临时上下文、原生 IndexedDB 和实际网页同步/存储模块；网页静态模块在服务器同源地址由测试路由加载，业务请求直接到 Rust 服务，保留认证与 CSRF 检查。

执行顺序：Android 实际 JNI 上传 PDF、PortableInk、卡片和复习事件 → iOS StudyStore 同步并以 PencilKit 编辑 → iOS 校验 Android ZIP 并重新封装 → Android 校验和恢复 iOS ZIP → 真实 Chrome 接收资料并新增/修改/删除笔记 → Android 接收 iOS 与网页业务后增加第三条笔画 → 新 iOS 工作区验证可继续编辑、网页笔记及复习历史。所有数据均由生成样例组成；报告中的 webUIVerified=false 表示未操作网页产品界面的全部控件，不能将浏览器同步模块运行等同于完整网页 UI 验收。

脚本 finally 清理自身服务器、回环转发和专用 Apple 模拟器；测试业务库保留在忽略的 .tools 中用于失败调查。每次使用新的证据目录。中断后应检查本轮专用模拟器与进程，不得关闭其他设备或应用。

test-pdf-windows.ps1 默认在独立 Android 验收设备执行 320/360/412/600/720/840/1024dp 与字号 1/1.3/2，可用 Widths/Fonts 参数缩小指定设备的组合，验证实际窗口值、双文档独立与同步滚动、结束对照的阅读位置，并保存真实截图。脚本恢复字号，设备测试恢复其原窗口大小和密度。汉王真机、物理笔事件、完整离线并发冲突及网络故障矩阵另行验收。

旧版 Android 的 wm 窗口覆盖会受虚拟设备原生屏幕大小限制。完整矩阵应使用原生屏幕至少 1024×1280、160dpi 的专用 SDK 设备，再申请各窗口；320px 宽虚拟屏幕不能证明 720–1024dp 的布局。实际尺寸与请求不符时脚本明确失败，不用请求参数冒充测量结果。2026-10-10 的 API28 完整矩阵使用专用 ShufangParity28-20261008 虚拟设备，调整前的超限尝试保留在运行报告中。
