#!/bin/bash
# Public rolling release discovery; transactional implementation uses stock Python 3.
set -euo pipefail
exec python3 "$(dirname "$(readlink -f "$0")")/update.py"
