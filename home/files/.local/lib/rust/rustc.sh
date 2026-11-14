#!/bin/sh
# Cargo supplies the selected compiler followed by its original arguments
exec /usr/sbin/taskpolicy -c utility "$@"
