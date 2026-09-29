# Ansible

`bootstrap.py` is an executable, standard-library-only Python 3.9+ script. It
does not read `pyproject.toml` or `uv.lock`.

- `just bootstrap` prepares Homebrew, uv, Ansible's Python runtime, and
  collections. Ansible and Python versions are declared in `bootstrap.py`.
- `just setup` prepares dependencies, installs userland, applies dotfiles, and
  configures the host.
- `just ansible --tags helium` runs selected tasks using the installed runtime.
  Chezmoi hooks call `bootstrap.py run` without installing tools.

Bootstrap and setup accept `--plan` to list steps, `--only STEP` to select them,
and `--from STEP` to resume. Skipped prerequisites must already be installed.

On NixOS, bootstrap uses the system Ansible and only installs collections.

Setup installs missing Brewfile entries without upgrading existing packages. Use
`just update` to upgrade them too.

Custom modules must support check mode. Avoid restarting Tailscale while
applying SELinux policy over Tailscale SSH; that can disconnect the session.
