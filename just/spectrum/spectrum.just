import '../common.just'

set working-directory := '../..'
set default-list

export BB_BUILD_DRIVER := "podman"
export BB_RUN_DRIVER := "podman"

# Validate the recipe and enforce the Renovate-managed base digest lock.
[group('spectrum')]
[linux]
validate: (_doctor 'nix')
    nix develop .#operations --command \
      {{ just_command }} spectrum _validate

[linux]
_validate: (_doctor 'spectrum')
    generated=$(mktemp)
    trap 'rm -f "$generated"' EXIT
    {{ just_command }} spectrum generate "$generated"
    locked=$(< systems/spectrum/recipes/spectrum.lock)
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
generate output:
    generated={{ quote(output) }}
    bluebuild=${BLUEBUILD:-bluebuild}
    validator=${CHECK_JSONSCHEMA:-check-jsonschema}
    readonly schema_base_uri=https://schema.blue-build.org/
    bun systems/spectrum/recipes/spectrum/sources/sources.ts
    # Include nested stage and module files in schema validation
    shopt -s globstar
    "$validator" \
      --base-uri "$schema_base_uri" \
      --schemafile "${schema_base_uri}recipe-v2.json" \
      systems/spectrum/recipes/spectrum.yml
    "$validator" \
      --base-uri "$schema_base_uri" \
      --schemafile "${schema_base_uri}stage-v1.json" \
      systems/spectrum/recipes/spectrum/stages/**/*.yml
    "$validator" \
      --base-uri "$schema_base_uri" \
      --schemafile "${schema_base_uri}module-list-v1.json" \
      systems/spectrum/recipes/spectrum/modules/**/*.yml
    # Compare recipe data with the lock, independent of generated shell syntax
    bun -e '
      const recipe = Bun.YAML.parse(await Bun.file("systems/spectrum/recipes/spectrum.yml").text());
      const { registry, repository, tag, digest } = recipe.base.image;
      const expected = (await Bun.file("systems/spectrum/recipes/spectrum.lock").text()).trim();
      if (`${registry}/${repository}:${tag}@${digest}` !== expected)
        throw new Error("Recipe base image does not match spectrum.lock");
    '
    # BlueBuild's feature-gated v2 parser is ready, but its validate command
    # still hardcodes the v1 schema. The official v2 schema is checked above.
    "$bluebuild" generate --skip-validation --output "$generated" systems/spectrum/recipes/spectrum.yml

# Build the local Spectrum image from the BlueBuild recipe v2 definition.
[group('spectrum')]
[linux]
build: (_doctor 'nix')
    nix develop .#operations --command \
      {{ just_command }} spectrum _build

[linux]
_build: _validate
    # Nix shells use /tmp, whose tmpfs quota can be smaller than an image layer.
    TMPDIR=/var/tmp bluebuild build --skip-validation --no-sign systems/spectrum/recipes/spectrum.yml

# Validate and switch with the same pinned CLI, rather than the booted image's CLI
[group('spectrum')]
[linux]
[positional-arguments]
switch *args: (_doctor 'nix')
    nix develop .#operations --command \
      {{ just_command }} spectrum _switch "$@"

[linux]
[positional-arguments]
_switch *args: _validate
    # BlueBuild captures bootc's output, so authenticate before its hidden prompt
    sudo -v
    # Keep the ticket valid across long builds without changing sudo policy
    (while sleep 60; do sudo -n -v || exit; done) &
    sudo_keepalive=$!
    trap 'kill "$sudo_keepalive" 2>/dev/null || :; wait "$sudo_keepalive" 2>/dev/null || :' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    # Match build's disk-backed temporary storage for the image transfer
    TMPDIR=/var/tmp bluebuild switch --skip-validation "$@" systems/spectrum/recipes/spectrum.yml
