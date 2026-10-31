"""Locate the Espressif toolchain binaries the device debug scripts need.

The original scripts hard-coded one Mac's ``~/.espressif`` path, which made
every conclusion unreproducible on a different machine. Resolution order is:

1. ``OPENOCD_BIN`` environment variable (explicit override)
2. the newest ``~/.espressif/tools/openocd-esp32/*/openocd-esp32/bin/openocd``
3. whatever ``openocd`` is on ``PATH``

Nothing here downloads or installs anything; if none of the above exist the
caller gets a message with the two ways to fix it.
"""

import os
import shutil
from pathlib import Path

OPENOCD_GLOB = '.espressif/tools/openocd-esp32/*/openocd-esp32/bin/openocd'

_HINT = (
    '找不到 openocd。二选一：\n'
    '  - 用 ESP-IDF 的 export.sh 配好环境（会带上 openocd）\n'
    '  - 或者设置 OPENOCD_BIN=/path/to/openocd'
)


def openocd_bin():
    """Return an absolute path to openocd, or raise RuntimeError with a hint."""
    override = os.environ.get('OPENOCD_BIN', '').strip()
    if override:
        path = Path(override).expanduser()
        if not path.is_file():
            raise RuntimeError(f'OPENOCD_BIN 指向的文件不存在: {path}')
        return str(path)

    # Version directories sort lexicographically well enough for the `vX.Y.Z-*`
    # names ESP-IDF installs; pick the newest.
    candidates = sorted(Path.home().glob(OPENOCD_GLOB))
    if candidates:
        return str(candidates[-1])

    found = shutil.which('openocd')
    if found:
        return found

    raise RuntimeError(_HINT)
