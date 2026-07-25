#!/usr/bin/env python3.14

import argparse
import io
from pathlib import Path
from xml.etree.ElementTree import Element, ElementTree, indent, register_namespace

from defusedxml.ElementTree import fromstring


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("pom", type=Path)
    parser.add_argument("ghidra_version")
    parser.add_argument("build_stamp")
    return parser.parse_args()


def namespace_for(root: Element) -> str:
    if root.tag.startswith("{"):
        return root.tag[1:].partition("}")[0]
    return ""


def qualified(name: str, namespace: str) -> str:
    return f"{{{namespace}}}{name}" if namespace else name


def set_text(root: Element, namespace: str, name: str, value: str) -> None:
    element = root.find(f".//{qualified(name, namespace)}")
    if element is None:
        raise SystemExit(f"missing POM property: {name}")
    element.text = value


def write_xml(path: Path, root: Element, *, xml_declaration: bool) -> None:
    indent(root)
    buffer = io.BytesIO()
    ElementTree(root).write(
        buffer,
        encoding="utf-8",
        xml_declaration=xml_declaration,
        short_empty_elements=True,
    )
    data = buffer.getvalue()
    if not data.endswith(b"\n"):
        data += b"\n"
    path.write_bytes(data)


def rewrite_pom(path: Path, ghidra_version: str, stamp: str) -> None:
    text = path.read_text(encoding="utf-8")
    root = fromstring(text)
    namespace = namespace_for(root)
    if namespace:
        register_namespace("", namespace)

    set_text(root, namespace, "ghidra.version", ghidra_version)
    set_text(root, namespace, "build.timestamp", stamp)
    set_text(root, namespace, "build.number", stamp)
    write_xml(path, root, xml_declaration=text.lstrip().startswith("<?xml"))


def main() -> int:
    args = parse_args()
    rewrite_pom(args.pom, args.ghidra_version, args.build_stamp)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
