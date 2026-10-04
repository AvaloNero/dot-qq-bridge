#!/usr/bin/env python3
"""Readiness-only entrypoint using the live launcher's shared Linux lease and stop."""
import importlib.util
from pathlib import Path


def load_stack():
    spec = importlib.util.spec_from_file_location('portable_tunnel_stack', Path(__file__).with_name('live-stack.py'))
    stack = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(stack)
    return stack


def main(argv=None):
    return load_stack().main(argv, readiness=True)


if __name__ == '__main__':
    raise SystemExit(main())
