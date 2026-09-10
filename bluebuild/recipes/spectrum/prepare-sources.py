"""Materialize Spectrum build inputs from the current flake lock."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def input_pin(lock: dict, name: str) -> dict:
    node_name = lock["nodes"][lock["root"]]["inputs"][name]
    node = lock["nodes"][node_name]
    return node["locked"] | {"ref": node["original"].get("ref")}


def main() -> None:
    lock = json.loads((ROOT / "flake.lock").read_text(encoding="utf-8"))
    directory = ROOT / "bluebuild/recipes/spectrum/sources"
    directory.mkdir(exist_ok=True)
    groups = {
        "astral": ["python-astral"],
        "ghostty": ["ghostty", "ghostty-zig-x86-64-linux"],
        "kanata": ["kanata-homebrew"],
    }
    for group, names in groups.items():
        pins = {name: input_pin(lock, f"source-{name}") for name in names}
        (directory / f"{group}.json").write_text(
            json.dumps({"pins": pins}, indent=2, sort_keys=True) + "\n"
        )
    patches = input_pin(lock, "patches")
    (directory / "patches.json").write_text(
        json.dumps(
            {
                "repository": f"https://github.com/{patches['owner']}/{patches['repo']}.git",
                "revision": patches["rev"],
            },
            indent=2,
            sort_keys=True,
        )
        + "\n"
    )
    revision = input_pin(lock, "source-bluebuild-cli")["rev"]
    recipe = ROOT / "bluebuild/recipes/spectrum.yml"
    text = recipe.read_text()
    if text.count("\nspec:\n") != 1:
        raise ValueError("Spectrum recipe must contain exactly one spec mapping")
    text = text.replace(
        "\nspec:\n",
        f"\nspec:\n  tool-versions:\n    bluebuild: {revision}\n",
    )
    (recipe.parent / ".spectrum.generated.yml").write_text(text)


if __name__ == "__main__":
    main()
