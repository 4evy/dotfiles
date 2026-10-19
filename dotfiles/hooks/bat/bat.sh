#!/bin/sh
set -eu

if command -v bat >/dev/null 2>&1; then
	bat cache --build >/dev/null
elif command -v batcat >/dev/null 2>&1; then
	batcat cache --build >/dev/null
fi
