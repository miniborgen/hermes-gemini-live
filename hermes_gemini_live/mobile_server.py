"""Run the private Gemini Live mobile surface on a loopback port."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

import uvicorn
from dotenv import load_dotenv

from .mobile_app import create_app


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Serve the private Hermes Gemini Live PWA")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=65183)
    parser.add_argument("--allowed-login", required=True)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    home = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes").expanduser()
    load_dotenv(home / ".env", override=False)
    app = create_app(allowed_login=args.allowed_login)
    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        proxy_headers=True,
        forwarded_allow_ips="127.0.0.1",
        server_header=False,
        access_log=False,
    )


if __name__ == "__main__":
    main()
