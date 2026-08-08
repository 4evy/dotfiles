# Workstation commands

This package contains user-invoked commands whose implementation benefits from
the shared Python runtime and dependencies. Its boundary is intentionally
narrow:

- application and host provisioning belongs to the relevant Ansible role;
- chezmoi lifecycle orchestration belongs in `dotfiles/.chezmoiscripts`;
- service policies, desktop entries, and role-only helpers live beside the
  Ansible role that deploys them;
- this package retains focused commands such as `jj-get`, `phone-mirror`,
  `discord-equicord`, and the desktop diagnostics/theme helpers.

There is no umbrella dispatcher. Callers should invoke a focused console script
or the owning Ansible/chezmoi workflow directly.
