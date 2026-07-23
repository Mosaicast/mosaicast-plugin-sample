#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 The Mosaicast Authors
set -euo pipefail
( cd backend  && ./gradlew --quiet clean jar )
( cd frontend && npm ci && npm run build )       # Vite → frontend/build/sample.es.js
rm -rf dist && mkdir -p dist/assets
cp backend/build/libs/*.jar dist/
cp frontend/build/*.es.js   dist/assets/
cp plugin.json              dist/
echo "✓ dist/ ready — copy to \$MOSAICAST_PLUGINS_DIR and restart core"
