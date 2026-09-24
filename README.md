# dotfiles

<!--
Built by a bi trans person. Queer people belong in tech. If that bothers you,
fuck off
-->

My personal workstation config for Spectrum/Bluefin, NixOS, and macOS

> [!IMPORTANT]
> This repository is for my machines. It's public for reference, but it isn't
> a reusable installer or a supported project

<p align="center">
  <img src=".github/assets/readme-hero.svg" width="72%">
</p>

The goal is to make every machine feel like mine without maintaining the same
config four times

## Rebuilding a machine

I keep the repo at `~/dotfiles`:

``` bash
git clone https://github.com/4evy/dotfiles.git ~/dotfiles
cd ~/dotfiles
```

<details>
<summary><strong>Spectrum / Bluefin</strong></summary>

<br>

On a fresh Bluefin install, I switch to the Spectrum image:

``` bash
sudo bootc switch ghcr.io/4evy/spectrum:latest
systemctl reboot
```

After the reboot, I finish the setup:

``` bash
cd ~/dotfiles
just setup
```

</details>

<details>
<summary><strong>NixOS</strong></summary>

<br>

On an installed NixOS system, I apply the flake and finish the shared setup:

``` bash
sudo nixos-rebuild \
  --option extra-substituters https://install.determinate.systems \
  --option extra-trusted-public-keys cache.flakehub.com-3:hJuILl5sVK4iKm86JzgdXW12Y2Hwd5G07qKtHTOcDCM= \
  --flake .#nixos \
  switch
just setup
```

The extra cache options are only needed for the first rebuild. Afterward, this
shorter command is enough:

``` bash
sudo nixos-rebuild switch --flake .#nixos
```

</details>

<details>
<summary><strong>macOS</strong></summary>

<br>

This path needs macOS 26 or newer. From the cloned repo, I run:

``` bash
./ansible/bootstrap.sh --setup
```

The script bootstraps Homebrew and Ansible, installs the userland, applies the
dotfiles, and configures the Mac. It asks for administrator and 1Password
access when needed

</details>

## Commands

`just` or `just --list --list-submodules` shows every recipe for the current
host

<details>
<summary><strong>Everyday commands</strong></summary>

<br>

| Command                           | Aliases             | Purpose                                                  |
| --------------------------------- | ------------------- | -------------------------------------------------------- |
| `just setup`                      | `just s`            | Bootstrap and apply everything                           |
| `just update`                     | `just up`           | Update userland, dotfiles, and host setup                |
| `just dotfiles-diff`              | `just diff`         | Preview pending chezmoi changes                          |
| `just apply [targets...]`         | `just a`            | Apply all dotfiles or only the given targets             |
| `just status`                     | -                   | Linux: Show Spectrum image status                        |
| `just doctor [profile]`           | -                   | Check every workflow dependency or one profile           |
| `just determinate-status`         | -                   | Show the Determinate version, features, and daemon state |
| `just determinate-upgrade`        | -                   | Upgrade installer-managed Determinate Nix                |
| `just nix`                        | `just nx`           | Install Nix and ensure its profile tools are available   |
| `just spectrum-validate`          | `just validate`     | Linux: Validate the BlueBuild recipe and base digest     |
| `just spectrum-build`             | `just build`        | Linux: Build Spectrum locally                            |
| `just fmt`                        | `just f`            | Format the repository                                    |
| `just check-format`               | `just cf`           | Check repository formatting without retaining rewrites   |
| `just lint`                       | `just l`            | Run static checks                                        |
| `just check`                      | `just c`, `just ck` | Run the full validation suite                            |
| `just python-typecheck [args...]` | `just typecheck`    | Type-check Python, forwarding optional arguments         |
| `just watch [recipe]`             | `just w`            | Rerun a recipe when files change                         |
| `just reboot`                     | `just r`            | Linux: Reboot the host after confirmation                |
| `just help [command]`             | `just h`            | List recipes or show command usage                       |

Run `just help <command>` with either a command or alias for argument details.

I keep shared tool configuration at the root: `.editorconfig` for shell
formatting, `.yamlfmt` for YAML, and `.luacheckrc` for Lua globals. Direct tool
commands, editor integrations, and the Nix checks read the same settings.
`go.work` connects the `records` command and `theme-run`, so I can check both
modules from here with `go vet ./packages/records/... ./packages/theme-run/...`.

For direct Nix work, drop down a level:

``` bash
nix develop
just nix-check
```

</details>

## License

[MIT](LICENSE)
