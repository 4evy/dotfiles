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

Requires macOS 27 or newer. From the cloned repo, I run:

``` bash
./ansible/bootstrap.sh --setup
```

The script asks for administrator and 1Password access when needed

</details>

Run `just --list --list-submodules` for commands or `just help <command>`
for usage and aliases.

## License

[MIT](LICENSE)
