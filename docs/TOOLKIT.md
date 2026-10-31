# 设备调试工具链

`tools/device/` 下的脚本用于读取固件、修改 NVS、抓串口和驱动底座电机。
它们**不是**日常运行入口，是让每个硬件结论都能复现的工具。

这些脚本最初针对一台 Mac 写成，路径、端口和串口名都按当时的环境硬编码。
迁入本仓库时做了两处改动：

- openocd 路径改为 `toolenv.openocd_bin()` 解析（环境变量 → `~/.espressif` → `PATH`）
- 依赖旧后端（8098/8099 端口、`xiaozhi_server.py`、pinggy 隧道、`/tmp/xz_server.log`）
  的脚本没有迁入，仍留在旧仓库

## 串口与网络

| 脚本 | 用途 | 前置条件 |
|---|---|---|
| `device_ports.py` | 按 USB 串口和 MAC 识别猫头/底座，返回 `/dev/cu.*` | ESP-IDF 的 python 环境 |
| `switch_wifi.py` | 把 Wi-Fi 与 `ota_url` 写进设备 NVS | 需先把 `ota_url` 指向 `aihub-server` 的 OTA 地址 |
| `nvs_edit.py` | 读写 NVS 分区条目 | — |
| `make_face_assets.py` | 生成表情资源 | — |
| `configure_wake_assets.py` | 生成唤醒词资源 | — |

## JTAG

底座是 ESP32-C3，通过 USB-JTAG 访问。两块板同时插着时 openocd 会自动挑第一个，
所以 `jt.py` 用 `BASE_SERIAL` 按序列号锁定底座；**换成你自己的底座必须改这个常量**，
否则指令会静默打到猫头（S3）上。

| 脚本 | 用途 |
|---|---|
| `jt.py` | 流式执行 openocd 命令并给每条输出打时间戳；`jt.py count` 采样定时器估算 PWM 频率 |
| `motor_demo.py` | 直接写 LEDC duty 驱动电机（固件空闲时不会被覆盖） |
| `motor_test.py` | 固件运行中能否抢占 PWM 的对照实验 |
| `miaoban.py` | 底座旋转工具箱 |

```sh
cd tools/device
python3 jt.py count 120
python3 motor_demo.py --duty 400
```

`toolenv.py` 找不到 openocd 时会给出两条修复路径（`export.sh` 或 `OPENOCD_BIN`）。

## 没有迁进来的脚本

以下脚本与已被取代的旧后端强绑定，迁入只会留下跑不通的代码：

| 脚本 | 原因 |
|---|---|
| `bootstack.py` | 启动旧后端 `xiaozhi_server.py`，走 pinggy 隧道 |
| `watch_connect.py` | `tail /tmp/xz_server.log`，依赖旧后端日志格式 |
| `xiaozhi_server.py`、`voice_brain.py`、`voice_loop.py`、`streaming_reply.py`、`auto_reply.py` | 旧后端实现，已被 `aihub-server` 取代 |

需要对照时请查旧仓库 `miaoban-voicehub`。
