"""Format stylesheets while preserving the palette generator's placeholders"""

import re
import subprocess
import sys
from pathlib import Path

for argument in sys.argv[2:]:
    path = Path(argument)
    original = path.read_text()
    placeholders = {}

    def protect(match):
        token = f"TREEFMT_PLACEHOLDER_{len(placeholders)}__"
        if match[0] == "${legacy}":
            token = f"/* {token} */"
        placeholders[token] = match[0]
        return token

    protected = re.sub(r"\$\{\w+\}|@[A-Z][A-Z0-9_]*@", protect, original)
    parser_path = path.with_suffix("") if path.suffix == ".in" else path
    formatted = subprocess.run(
        [sys.argv[1], "--stdin-filepath", str(parser_path)],
        input=protected,
        text=True,
        stdout=subprocess.PIPE,
        check=True,
    ).stdout
    for token, placeholder in placeholders.items():
        if formatted.count(token) != 1:
            raise ValueError(f"formatter changed a placeholder in {path}")
        formatted = formatted.replace(token, placeholder)
    if formatted != original:
        path.write_text(formatted)
