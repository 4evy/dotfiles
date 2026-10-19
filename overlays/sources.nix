{ inputs, lib }:
let
  lock = lib.importJSON ../flake.lock;
  lockInputs = lock.nodes.${lock.root}.inputs;
  sourceInputs = lib.filterAttrs (name: _: lib.hasPrefix "source-" name) inputs;
  version =
    name: lock.nodes.${lockInputs.${name}}.original.ref or inputs.${name}.shortRev or "unknown";
in
_final: _prev: {
  dotfilesSourcePins = lib.mapAttrs' (
    name: source:
    lib.nameValuePair (lib.removePrefix "source-" name) (
      source
      // {
        revision = source.rev or "";
        version = version name;
      }
    )
  ) sourceInputs;
}
