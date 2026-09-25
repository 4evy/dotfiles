# Validate the recipe and enforce the Renovate-managed base digest lock.
[group('spectrum')]
[linux]
spectrum-validate: (doctor 'nix')
    nix develop .#operations --command \
      {{ just_command }} _spectrum-validate

[linux]
_spectrum-validate: (doctor 'spectrum')
    generated=$(mktemp)
    trap 'rm -f "$generated"' EXIT
    {{ just_command }} spectrum-generate "$generated"
    locked=$(< bluebuild/recipes/spectrum.lock)
    tagged=${locked%@*}
    expected_arg="${tagged%:*}@${locked##*@}"
    resolved=$(skopeo inspect --format '{{ "{{.Digest}}" }}' "docker://$expected_arg")
    [[ "$locked" == *@$resolved ]] || {
      printf 'base image lock mismatch: %s resolves to %s\n' "$locked" "$resolved" >&2
      exit 1
    }

# Generate and validate the Containerfile used by local builds and CI.
[group('spectrum')]
[linux]
spectrum-generate output:
    generated={{ quote(output) }}
    bluebuild=${BLUEBUILD:-bluebuild}
    validator=${CHECK_JSONSCHEMA:-check-jsonschema}
    uv run --no-project --python "$(cat .python-version)" python bluebuild/recipes/spectrum/prepare-sources.py
    export BLUEBUILD_CLI_REVISION
    BLUEBUILD_CLI_REVISION=$(jq -r '.nodes[.nodes[.root].inputs["source-bluebuild-cli"]].locked.rev' flake.lock)
    "$validator" \
      --base-uri https://schema.blue-build.org/ \
      --schemafile https://schema.blue-build.org/recipe-v2.json \
      bluebuild/recipes/spectrum.yml
    "$validator" \
      --base-uri https://schema.blue-build.org/ \
      --schemafile https://schema.blue-build.org/stage-v1.json \
      bluebuild/recipes/spectrum/stages/*.yml
    "$validator" \
      --base-uri https://schema.blue-build.org/ \
      --schemafile https://schema.blue-build.org/module-list-v1.json \
      bluebuild/recipes/spectrum/modules/*.yml
    # BlueBuild's feature-gated v2 parser is ready, but its validate command
    # still hardcodes the v1 schema. The official v2 schema is checked above.
    "$bluebuild" generate --skip-validation --output "$generated" bluebuild/recipes/spectrum.yml
    cli_revision=$(jq -r '.nodes[.nodes[.root].inputs["source-bluebuild-cli"]].locked.rev' flake.lock)
    grep -Fq "COPY --from=ghcr.io/blue-build/cli:${cli_revision}-installer" "$generated"
    grep -Fq '/out/bluebuild /bins/bluebuild' "$generated"
    grep -Fq -- '--mount=type=cache,sharing=locked,dst=/var/cache/rpm-ostree,id=rpm-ostree-cache-spectrum-' "$generated"
    grep -Fq -- '--mount=type=cache,sharing=locked,dst=/var/cache/libdnf5,id=dnf-cache-spectrum-' "$generated"
    grep -Fq 'bluebuild/recipes/spectrum/sources/astral.json /src/sources.json' "$generated"
    grep -Fq 'bluebuild/recipes/spectrum/sources/ghostty.json /src/sources.json' "$generated"
    grep -Fq 'bluebuild/recipes/spectrum/sources/kanata.json /src/sources.json' "$generated"
    grep -Fq 'packages/hyper-window-tiling/package.json /src/package.json' "$generated"
    grep -Fq -- '--mount=type=cache,id=spectrum-ghostty-zig-global-v1,sharing=locked,target=/build/zig-cache' "$generated"
    grep -Fq -- '--mount=type=cache,id=spectrum-ghostty-zig-local-v1,sharing=locked,target=/build/source/.zig-cache' "$generated"
    grep -Fq -- '--mount=type=cache,id=spectrum-hyper-window-tiling-bun-v1,sharing=locked,target=/root/.bun/install/cache' "$generated"
    grep -Fq -- '--mount=type=cache,id=spectrum-kanata-target-v1,sharing=locked,target=/build/kanata-source/target' "$generated"
    ! grep -Fq 'flake.lock /src/' "$generated"
    locked=$(< bluebuild/recipes/spectrum.lock)
    tagged=${locked%@*}
    expected_arg="${tagged%:*}@${locked##*@}"
    grep -Fq "ARG BASE_IMAGE=\"$expected_arg\"" "$generated"
    grep -Fq -- '-Dcpu=baseline' "$generated"
    ! grep -qw akmods bluebuild/recipes/spectrum.yml "$generated"

# Build the local Spectrum image from the BlueBuild recipe v2 definition.
[group('spectrum')]
[linux]
spectrum-build: (doctor 'nix')
    nix develop .#operations --command \
      {{ just_command }} _spectrum-build

[linux]
_spectrum-build: _spectrum-validate
    # Nix shells use /tmp, whose tmpfs quota can be smaller than an image layer.
    export BLUEBUILD_CLI_REVISION
    BLUEBUILD_CLI_REVISION=$(jq -r '.nodes[.nodes[.root].inputs["source-bluebuild-cli"]].locked.rev' flake.lock)
    TMPDIR=/var/tmp bluebuild build --skip-validation --no-sign bluebuild/recipes/spectrum.yml
