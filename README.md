# 一起看 · 独立新版

Windows 与 Android 同步观影客户端。视频由各设备分别加载，同步服务器负责房间、聊天与播放状态。

当前版本：Windows 1.6.3 / Android 5.3。

## 功能

- 公共 Syncplay 邀请和六位房号；默认服务器 syncplay.pl:8999。
- 网页邀请携带同步服务器、端口和房号，电脑版可开启外网访问。
- 双端独立设置页、手机五项导航、全屏聊天与快捷回复。
- 多动漫源、本机可用性探测、规则更新检查和本地下载。
- 安卓返回优先退出全屏，然后处理页面返回。
- 外网线路先核对本应用实例，持续检测连接状态。

## 本地运行

需要 Python 3.12 或更高版本，核心服务使用标准库。

    python app.py --port 8770 --no-browser --local-only

然后打开 http://127.0.0.1:8770/ 。界面回归可用 Node.js 执行 tests 目录中的 .cjs 测试。

## 构建说明

Windows 使用 PyInstaller 和 .NET 启动器；tools/build_exe.py 需要先准备 dist/TogetherWatch。

Android 构建入口为 tools/build_next_phone.ps1，需要 JDK 17 与 Android SDK。脚本仍含本机工具链路径，需要通过参数指定自己的工具链。也可以在原生代码未变更时使用 tools/build_phone_assets.py 更新先前 APK 的界面资源，再调用官方 apksig 签名库签名。

input/base.apk 是用户提供的原生功能基线。Android 保留其现有原生实现并增加源码形式的 NextActivity；不能将编译用 MainActivity 声明打入 APK。完整重建仍需要 Android 构建工具及相应基线文件。

私有签名文件不在仓库中。使用自己的密钥并通过 WT_SIGN_PASSWORD 环境变量提供口令；不要将签名文件、Cookie、账号数据或服务器凭据提交到 Git。更换签名不能覆盖安装原签名版本。

## 验证范围

已验证同步协议、邀请参数、连接状态、返回顺序以及部分下载和播放回归。实体手机返回手势及朋友真实网络中的完整播放仍需复测。Windows 原生构建需要 Windows 环境。

源规则参考 Predidit/KazumiRules；播放器包含第三方 HLS 实现及其许可证。其他媒体与上游内容的权利属于各自权利人。本仓库尚未选择项目整体的开源许可证。
