{ inputs }:
let
  lock = builtins.fromJSON (builtins.readFile ../flake.lock);
  version =
    name:
    lock.nodes.${lock.nodes.${lock.root}.inputs.${name}}.original.ref or inputs.${name}.shortRev
      or "unknown";
in
_final: _prev: {
  dotfilesSourcePins = builtins.listToAttrs (
    map (name: {
      name = builtins.substring 7 (-1) name;
      value = inputs.${name} // {
        revision = inputs.${name}.rev or "";
        version = version name;
      };
    }) (builtins.filter (name: builtins.match "source-.*" name != null) (builtins.attrNames inputs))
  );
}
