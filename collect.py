#!/usr/bin/env python3
"""Hermes Spend Dashboard — CLI entry point (thin wrapper).

## Connections
- IMPORTS FROM: spenddash.cli (main)
- EXPORTS: nothing (script)
- CALLED BY: user/terminal
- CALLS: spenddash.cli.main
- CONTRACT: this file exists only so `python3 collect.py --once|--serve`
  works from the repo root; all behavior lives in spenddash/. See
  spenddash/cli.py for the mode rules.
"""
import sys

from spenddash.cli import main

if __name__ == "__main__":
    sys.exit(main())
