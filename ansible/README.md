# Ansible

Setup installs missing Brewfile entries without upgrading existing packages.
Use `just update` to upgrade them too.

Custom modules must support check mode. Avoid restarting Tailscale while
applying SELinux policy over Tailscale SSH; that can disconnect the session.
