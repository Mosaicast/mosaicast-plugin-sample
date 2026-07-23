#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 The Mosaicast Authors
set -euo pipefail
: "${MOSAICAST_PLUGINS_DIR:?Set MOSAICAST_PLUGINS_DIR or copy dist/ manually}"
dest="$MOSAICAST_PLUGINS_DIR/sample"
rm -rf "$dest" && mkdir -p "$dest"
cp -r dist/* "$dest/"
echo "✓ installed to $dest — restart core"
