#!/bin/sh
# Pinned Solidity dependencies for contracts/ (not vendored in git). Re-run after a clean checkout.
set -eu
cd "$(dirname "$0")"
fetch() { # name repo tag commit
  if [ -f "lib/$1/.pinned" ] && [ "$(cat "lib/$1/.pinned")" = "$4" ]; then return; fi
  rm -rf "lib/$1"
  git clone -q --depth 1 --branch "$3" "$2" "lib/$1"
  actual=$(git -C "lib/$1" rev-parse HEAD)
  [ "$actual" = "$4" ] || { echo "lib/$1: expected $4, got $actual" >&2; exit 1; }
  rm -rf "lib/$1/.git"
  echo "$4" > "lib/$1/.pinned"
}
fetch forge-std https://github.com/foundry-rs/forge-std.git v1.16.2 bf647bd6046f2f7da30d0c2bf435e5c76a780c1b
fetch openzeppelin-contracts https://github.com/OpenZeppelin/openzeppelin-contracts.git v5.4.0 c64a1edb67b6e3f4a15cca8909c9482ad33a02b0
