#!/bin/sh
set -eu

# This launcher intentionally uses only POSIX shell builtins. The release
# smoke test runs it with an empty PATH to prove that node/tsx/pnpm and other
# host tools are not runtime dependencies.
case "$0" in
  */*) launcher_dir=${0%/*} ;;
  *) launcher_dir=. ;;
esac
release_root=$(CDPATH= cd -- "$launcher_dir" && pwd)
cd "$release_root"

exec "$release_root/ygdria-server"
