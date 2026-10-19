#!/bin/sh
set -eu
exec bun "$HJEM_WORKING_TREE/scripts/setup/applications.ts" helium
