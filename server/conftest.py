"""pytest 配置：确保 server 目录在 sys.path 上，便于 `import server`"""

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))