import json
import os
import sys
from pathlib import Path


def main() -> None:
    resources = Path(sys.argv[1])
    codex_home = Path(os.environ.get("CODEX_HOME", sys.argv[2]))
    compatibility_marketplace = sys.argv[3]
    try:
        services = json.loads(os.environ.get("NODE_REPL_TRUSTED_SERVICES", "{}"))
    except ValueError:
        services = {}
    browser = services.get("browser") if isinstance(services, dict) else None
    if isinstance(browser, str):
        service = Path(browser)
        bundled = (
            resources
            / "plugins/openai-bundled/plugins/browser/scripts/browser-service.mjs"
        )
        cached = any(
            service.parent.parent.parent
            == codex_home / "plugins/cache" / marketplace / "browser"
            for marketplace in ("openai-bundled", compatibility_marketplace)
        )
        if service == bundled or (
            cached
            and service.parent.name == "scripts"
            and service.name == "browser-service.mjs"
        ):
            # ChatGPT can replace the bundled service with a cached plugin
            module_roots = os.environ.get("NODE_REPL_NODE_MODULE_DIRS", "")
            roots = os.pathsep.join(
                root for root in (os.fspath(service.parent), module_roots) if root
            )
            os.environ["NODE_REPL_NODE_MODULE_DIRS"] = roots
            os.environ["NODE_REPL_TRUSTED_CODE_PATHS"] = roots

    node_repl = resources / "cua_node/bin/node_repl"
    os.execv(node_repl, [os.fspath(node_repl), *sys.argv[4:]])


if __name__ == "__main__":
    main()
