"""Normalize text whitespace, including formats without a syntax formatter"""

import sys
from pathlib import Path

for argument in sys.argv[1:]:
    path = Path(argument)
    original = path.read_bytes()
    if not original or b"\0" in original:
        continue
    try:
        text = original.decode("utf-8")
    except UnicodeDecodeError:
        continue
    lines = text.replace("\r\n", "\n").split("\n")
    if path.suffix != ".md":
        lines = [line.rstrip(" \t") for line in lines]
    formatted = ("\n".join(lines).rstrip("\n") + "\n").encode()
    if formatted != original:
        path.write_bytes(formatted)
