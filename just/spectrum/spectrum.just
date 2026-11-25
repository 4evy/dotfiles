import '../module.just'

set default-list

export BB_BUILD_DRIVER := "podman"
export BB_RUN_DRIVER := "podman"

# Validate the recipe and its pinned base with the upstream CLI.
[group('spectrum')]
[linux]
validate: (_doctor 'nix')
    nix develop .#operations --command \
      {{ just_command }} spectrum _validate

[linux]
_validate:
    {{ just_command }} spectrum generate "${0%/*}/Containerfile"

# Generate the Containerfile once, with BlueBuild's recursive recipe validation.
[group('spectrum')]
[linux]
generate output: (_doctor 'spectrum')
    generated={{ quote(output) }}
    locked=$(bun systems/spectrum/recipes/spectrum/sources/sources.ts)
    bluebuild generate --output "$generated" systems/spectrum/recipes/spectrum.yml
    # BlueBuild resolves the recipe's tag@digest to a digest-only FROM
    tagged=${locked%@*}
    expected_ref="${tagged%:*}@${locked##*@}"
    IFS= read -r base_arg <"$generated"
    [[ $base_arg == "ARG BASE_IMAGE=\"$expected_ref\"" ]] || {
      printf 'Expected generated base %s, got %s\n' "$expected_ref" "$base_arg" >&2
      exit 1
    }

# Build public Spectrum and its private, machine-local recovery derivative.
[group('spectrum')]
[linux]
build profile="": (_doctor 'nix')
    nix develop .#operations --command \
      {{ just_command }} spectrum _build {{ quote(profile) }}

[linux]
_build profile="":
    generated="${0%/*}/Containerfile"
    sudo -v
    # Keep the ticket valid across long builds without changing sudo policy
    (while sleep 60; do sudo -n -v || exit; done) &
    sudo_keepalive=$!
    trap 'kill "$sudo_keepalive" 2>/dev/null || :; wait "$sudo_keepalive" 2>/dev/null || :' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    {{ just_command }} spectrum generate "$generated"
    # Build in bootc's rootful store, without a second rootless copy/archive
    sudo env TMPDIR=/var/tmp podman build --platform linux/amd64 --layers \
      --file "$generated" --tag localhost/spectrum:latest .
    sudo bash systems/spectrum/recovery/build.sh localhost/spectrum:latest {{ quote(profile) }}

# Rebuild recovery from an existing rootful image without rebuilding Spectrum.
[group('spectrum')]
[linux]
recovery base="localhost/spectrum-recovery:latest" profile="":
    sudo bash systems/spectrum/recovery/build.sh {{ quote(base) }} {{ quote(profile) }}

# Build and stage the private image, preserving recovery across local rebuilds.
[group('spectrum')]
[linux]
switch profile="": (_doctor 'nix')
    nix develop .#operations --command \
      {{ just_command }} spectrum _switch {{ quote(profile) }}

[linux]
_switch profile="": (_build profile)
    current=$(sudo bootc status --json | jq -r '.spec.image.image')
    if [[ $current == localhost/spectrum-recovery:latest ]]; then
      sudo bootc upgrade
    else
      sudo bootc switch --transport containers-storage localhost/spectrum-recovery:latest
    fi
