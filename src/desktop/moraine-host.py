"""Launch the installed upstream package with this workbench's local store."""
import os
import sys
import threading
from pathlib import Path

mode, directory = sys.argv[1:]
root = Path(directory)
token = (root / "access-token").read_text(encoding="utf-8").strip()
if not token:
    raise ValueError("Moraine access-token is empty")
os.environ["MORAINE_BETA_TOKEN"] = token

if mode == "mcp":
    from moraine.mcp_server import main

    os.environ["MORAINE_MCP_URL"] = "http://127.0.0.1:4790"
    os.environ["no_proxy"] = "127.0.0.1,localhost"
    main()
elif mode == "serve":
    from moraine.beta_server import create_beta_server

    # The beta creates an empty library when the seed path does not exist.
    env = {
        "MORAINE_BETA_HOST": "127.0.0.1",
        "MORAINE_BETA_PORT": "4790",
        "MORAINE_BETA_TOKEN": token,
        "MORAINE_BETA_DATA_FILE": str(root / "beta-store.json"),
        "MORAINE_BETA_SEED_FILE": str(root / "empty-seed.json"),
    }
    with create_beta_server(env) as server:
        def stop_with_parent():
            sys.stdin.buffer.read()
            server.shutdown()

        threading.Thread(target=stop_with_parent, daemon=True).start()
        print("ready", flush=True)
        server.serve_forever()
else:
    raise ValueError("Unsupported Moraine launch mode")
