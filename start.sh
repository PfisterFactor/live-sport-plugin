#!/bin/bash
set -e

if ! command -v bun &> /dev/null; then
    echo "[ERROR] Bun is not installed!"
    echo "Please install Bun from https://bun.sh/"
    exit 1
fi

bun install
bun run build
bun run start
