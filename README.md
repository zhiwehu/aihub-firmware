# aihub-firmware

AIHub 的设备侧仓库：EchoEar / 喵伴 ESP32 固件、串口与 JTAG 调试工具、浏览器 Web Serial
刷写助手、以及固件镜像校验与发布打包。

**浏览器在这里完成真正的刷机，服务端从不接触 USB。**

## 目录

```text
firmware/                 ESP-IDF 工程
├── head/                 EchoEar 猫头（ESP32-S3），含分区表、依赖锁、构建配置
├── base_controller/      底座控制器（ESP32-C3），角度闭环与限位保护
├── shared/               串口协议解析
└── README.md             上游来源、布局、构建与硬件边界

flash/                    浏览器刷机前端（Web Serial）
├── echoear-installer.js  升级 / 备份恢复 / 配网 / 验收助手
├── echoear-*.mjs         读取、NVS、备份、升级核心、网络重试
└── vendor/esptool-js-0.7.0/

tools/
├── device/               串口与 JTAG 工具（见 docs/TOOLKIT.md）
└── release/              镜像校验、隔离构建、发布打包

tests/                    9 个 C++ 逻辑测试 + 10 个 Node 测试
docs/                     USB 接入、升级验证记录、工具链说明
```

## 与 `aihub-server` 的接口

本仓库**不提供**任何网络端点。设备开机后轮询的 OTA 接口、设备令牌、局域网监听
都归 `aihub-server`。两个仓库之间只有两个契约：

### 1. OTA 地址

设备固件里配置的是 `http://<mac-lan-ip>:<port>/xiaozhi/ota/<device-token>/`。
地址由服务端生成，本仓库只负责把它写进设备 NVS（见 `tools/device/switch_wifi.py`）。
固件源码里的 `CONFIG_OTA_URL` 必须保持为空——发布包不得内嵌某台机器的地址。

### 2. 应用清单 `manifest.json`

服务端只校验 `board` / `kind` / `file` / `sha256` / 大小，**镜像深度校验在本仓库打包时完成**
（`tools/release/image.py`）。这样换板型不需要改服务端。

```json
{
  "board": "echoear-s3",
  "kind": "application",
  "file": "application.bin",
  "version": "2.0.5-aihub.1",
  "sha256": "<64 hex>",
  "source_commit": "<git sha>",
  "install": {
    "board": "echoear-s3",
    "partition_bytes": 3072,
    "partition_sha256": "<64 hex>",
    "upgrade_from_sha256": ["<64 hex>"],
    "validated": false
  }
}
```

`install.validated` 默认为 `false`。只有提供同一次构建的实机验证记录
（identity / backup / upgrade-readback / wifi / voice-reply / restore 六项）才置为 `true`。

### 3. 页面事件（网页控制台 ↔ 刷机面板）

刷机面板原本内嵌在网页控制台里，现在独立成模块。两者通过 `window` 上的自定义事件通信：

| 事件 | 方向 | 用途 |
|---|---|---|
| `aihub:firmware` | 控制台 → 面板 | 下达清单里选定的固件（`detail` 含 download 地址与 sha256） |
| `aihub:connection-prepared` | 面板 → 控制台 | 配网信息已就绪，控制台可刷新设备状态 |

模块在**所有面板元素绑定完成之后**注册 `window.AIHubFlasher`（`{client, module}`）。
控制台先按需 `import` 这个模块，再检查该全局：存在才显示刷机面板，否则退回文字向导。
面板的 DOM 骨架（`#echoear-installer` 那一段）归属控制台仓库，模块加载时按 id 直接绑定，
所以两边改 id 必须同时改。

锁名 `aihub-echoear-usb` 用于串口互斥。改名必须两侧同时改。

## 刷机页怎么打开

**Web Serial 只在 secure context 下可用**：`https://` 或 `http://localhost`。
直接双击 `flash/` 里的 HTML 是 `file://`，浏览器会拒绝授权串口。

两种可用方式：

```sh
# 1) 由 aihub-server 的网页控制台托管（正常路径）
#    服务端把本仓库的 flash/ 挂在 /firmware 下：
#    AIHUB_FIRMWARE_ROOT=<workspace>/aihub-firmware/flash
#    浏览器打开 http://127.0.0.1:8765/#connections，选中喵伴即可

# 2) 发布到 https 站点（例如 GitHub Pages），此时完全不需要后端
```

本仓库**不带入口 HTML**：面板骨架在 `aihub-web/public/index.html`，模块只负责绑定和
串口逻辑。单独起静态服务（`python3 -m http.server`）只会得到没有面板的裸模块。

## 构建固件

需要 ESP-IDF **5.4.0** 与对应工具链，细节见 [firmware/README.md](firmware/README.md)。

```sh
. $IDF_PATH/export.sh
cd firmware/head && idf.py set-target esp32s3 && idf.py build
```

本仓库不含原厂资源、提示音原始素材或 `sdkconfig`。首次构建前需按
`firmware/head/scripts/` 里的脚本准备资源。

## 发布一个升级包

隔离构建（不连接设备、不打开串口）：

```sh
python tools/release/build_echoear_upgrade.py --work /tmp/echoear-build --version 2.0.5-aihub.1
```

打包（校验镜像头、段校验和、内嵌 SHA256、分区表布局）：

```sh
python tools/release/package_echoear_release.py --help
```

打包器会检查分区表必须精确匹配 EchoEar 升级 profile，并拒绝覆盖已存在的发布目录。

## 测试

```sh
# C++ 控制逻辑（需要 c++ 编译器）
python tests/test_firmware_logic.py

# 浏览器刷机逻辑（需要 Node 18+）
node --test tests/*.mjs
```

两组测试都不刷写设备、不读取真实串口。硬件行为必须另行实机验收。

## 设备调试工具

见 [docs/TOOLKIT.md](docs/TOOLKIT.md)。其中 `tools/device/toolenv.py` 负责定位 openocd：

1. `OPENOCD_BIN` 环境变量
2. `~/.espressif/tools/openocd-esp32/*/openocd-esp32/bin/openocd` 中最新的一版
3. `PATH` 上的 `openocd`

## 不在本仓库的东西

| 内容 | 归属 |
|---|---|
| OTA 端点、设备令牌、局域网监听 | `aihub-server` |
| 固件产物托管与下载校验 | `aihub-server`（只验 sha256 和大小） |
| 设备整片备份的落盘 | `aihub-server` |
| 网页控制台其余部分 | `aihub-web` |
| 实时语音后端 | `aihub-server` / `aihub-models` |

## 历史与许可

本仓库从单体仓库 `miaoban-voicehub` 的 `firmware/`、根目录调试脚本和
`realtime_backend/voicehub/static/echoear-*` 迁出，**不带旧提交历史**。旧仓库保持冻结，
其中仍保留早期后端实验（`xiaozhi_server.py`、`voice_brain.py`、`voice_loop.py` 等）
和与之绑定的 `bootstack.py`、`watch_connect.py`；这些没有迁入。

原创代码 MIT（见 [LICENSE](LICENSE)），派生代码保留原版权声明，详见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。固件基于上游 ESP-IDF 与小智
生态，上游来源见 [firmware/README.md](firmware/README.md)。

### Per-device WebSocket provisioning

The USB setup page submits the inspected device MAC to the current server's
prepare API and writes the returned dedicated token/OTA URL into the existing NVS
fields. Deploy the updated server before using this setup page. No firmware
protocol or NVS layout change is required. Failed/repeated setup can leave unused
credentials; administrators can revoke them in the console. Keep old credentials
until the newly provisioned connection is verified. Existing devices are not
reconfigured automatically; legacy shared-token setup remains server-compatible.
