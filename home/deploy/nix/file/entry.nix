{ lib }:
/**
  Pass a normalized file recipe to Hjem, leaving source and text handling there

  # Inputs
  `entry` supplies `target` and optional flags `private`, `mutable`, and
  `executable`, all defaulting to `false`. `contents` supplies `source` or `text`

  # Type
  `normalizeFile :: AttrSet -> AttrSet -> AttrSet`

  # Examples
  `normalizeFile { target = ".config/tool"; private = true; } { text = ""; }`
  returns `{ target = ".config/tool"; type = "copy"; permissions = "0600";
  executable = false; text = ""; }`
*/
entry: contents:
let
  private = entry.private or false;
  mutable = entry.mutable or false;
  executable = entry.executable or false;
in
{
  inherit (entry) target;
  inherit executable;
  type = if private || mutable then "copy" else "symlink";
}
// contents
// lib.attrsets.optionalAttrs (private || mutable) {
  permissions =
    if private then
      if executable then "0700" else "0600"
    else if executable then
      "0755"
    else
      "0644";
}
