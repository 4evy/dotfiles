{ inputs, lib }:
let
  lock = lib.trivial.importJSON ../../flake.lock;
  lockInputs = lock.nodes.${lock.root}.inputs;
  sourceInputs = lib.attrsets.filterAttrs (name: _: lib.strings.hasPrefix "source-" name) inputs;

  /**
    Find a source input's version in the lock file. Fall back to its `shortRev`
    or `"unknown"` if neither is available.

    # Inputs

    `name`: Name of a flake input in `flake.lock`.

    # Type

    `version :: String -> String`

    # Examples

    ```nix
    version "source-toshy"
    => "Toshy_v26.11.0"
    ```
  */
  version =
    name: lock.nodes.${lockInputs.${name}}.original.ref or inputs.${name}.shortRev or "unknown";

  /**
    Build an updater for an input pinned to a stable release tag.

    # Inputs

    `final`: Package set providing the updater's builder and commands.
    `name`: Name of the GitHub flake input to update.

    # Type

    `taggedUpdater :: AttrSet -> String -> String`

    # Examples

    ```nix
    taggedUpdater final "source-toshy"
    => "/nix/store/…-update-source-toshy/bin/update-source-toshy"
    ```
  */
  taggedUpdater =
    final: name:
    let
      inherit (final)
        coreutils
        git
        jq
        nix
        sd
        writeShellApplication
        ;
    in
    lib.meta.getExe (writeShellApplication {
      name = "update-${name}";
      runtimeInputs = [
        coreutils
        git
        jq
        nix
        sd
      ];
      # Run from the checkout root, updating the owning input rather than a
      # second package pin, and stage both files before touching the checkout
      text = ''
        input=${lib.strings.escapeShellArg name}
        original=$(jq -ce --arg input "$input" \
          '.nodes[.nodes[.root].inputs[$input]].original' flake.lock)
        ref=$(jq -er '.ref' <<< "$original")
        tag=''${ref#refs/tags/}
        if [[ ! $tag =~ ^([^0-9]*)([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
          echo "Expected a release tag for $input, got $ref" >&2
          exit 1
        fi
        prefix=''${BASH_REMATCH[1]}
        repository=$(jq -er '.owner + "/" + .repo' <<< "$original")
        base="github:$repository/"
        remote="https://github.com/$repository.git"
        refs=$(git ls-remote --tags --refs "$remote" |
          sort -t $'\t' -k2,2Vr)
        latest=
        while IFS=$'\t' read -r _ candidate; do
          candidate=''${candidate#refs/tags/}
          if [[ $candidate == "$prefix"* &&
            ''${candidate#"$prefix"} =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
            latest=$candidate
            break
          fi
        done <<< "$refs"
        if [[ -z $latest ]]; then
          echo "No stable release tags found for $input" >&2
          exit 1
        fi
        old_url="$base$ref"
        new_url="$base''${ref%"$tag"}$latest"
        flake=$(< flake.nix)
        if [[ $flake != *"\"$old_url\""* ]]; then
          echo "Owning URL for $input not found in flake.nix" >&2
          exit 1
        fi
        staged=$(mktemp -d)
        trap 'rm -rf "$staged"' EXIT
        cp flake.nix flake.lock "$staged/"
        sd --fixed-strings "\"$old_url\"" "\"$new_url\"" "$staged/flake.nix"
        nix flake update --flake "$staged" "$input"
        cp "$staged/flake.nix" flake.nix
        cp "$staged/flake.lock" flake.lock
      '';
    });
in
final: _prev: {
  dotfilesPackageUpdaters = final.callPackage ../lib/package-updaters.nix { };
  dotfilesSourcePins = lib.attrsets.mapAttrs' (
    name: source:
    lib.attrsets.nameValuePair (lib.strings.removePrefix "source-" name) (
      source
      // {
        revision = source.rev or "";
        version = version name;
      }
      //
        lib.attrsets.optionalAttrs
          (
            !(lib.lists.elem name [
              "source-noto-color-emoji"
              "source-karabiner-vhid-package"
            ])
          )
          {
            updateScript =
              if name == "source-toshy" then
                taggedUpdater final name
              else
                final.dotfilesPackageUpdaters.flakeInputs [ name ];
          }
    )
  ) sourceInputs;
}
