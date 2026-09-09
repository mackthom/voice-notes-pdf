#!/bin/sh
# Start PDF Voice Notes (macOS / Linux). Windows users: double-click start.cmd
cd "$(dirname "$0")" || exit 1
node serve.mjs
