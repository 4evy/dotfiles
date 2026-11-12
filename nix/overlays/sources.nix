{ inputs, lib }:
let
  lock = lib.trivial.importJSON ../../flake.lock;
  lockInputs = lock.nodes.${lock.root}.inputs;
  sourceInputs = lib.attrsets.filterAttrs (name: _: lib.strings.hasPrefix "source-" name) inputs;
  version =
    name: lock.nodes.${lockInputs.${name}}.original.ref or inputs.${name}.shortRev or "unknown";
  taggedUpdater =
    final: name:
    lib.meta.getExe (
      final.writeShellApplication {
        name = "update-${name}";
        runtimeInputs = with final; [
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
          case $(jq -r '.type' <<< "$original") in
            github)
              repository=$(jq -r '.owner + "/" + .repo' <<< "$original")
              remote="https://github.com/$repository.git"
              base="github:$repository/"
              ;;
            git)
              remote=$(jq -er '.url' <<< "$original")
              base="git+$remote?ref="
              ;;
            *)
              echo "Unsupported release input: $input" >&2
              exit 1
              ;;
          esac
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
      }
    );
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
            !(builtins.elem name [
              "source-noto-color-emoji"
              "source-karabiner-vhid-package"
            ])
          )
          {
            updateScript =
              if
                builtins.elem name [
                  "source-toshy"
                  "source-uresourced"
                ]
              then
                taggedUpdater final name
              else
                final.dotfilesPackageUpdaters.flakeInputs [ name ];
          }
    )
  ) sourceInputs;
}
