#!/bin/sh
# Keep the launcher and system-managed extensions on the same generation
if [ -x /run/current-system/sw/bin/omp ]; then
	exec /run/current-system/sw/bin/omp "$@"
fi
exec @OMP_CLI@ "$@"
