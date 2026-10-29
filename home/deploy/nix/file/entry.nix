# Normalize deployment policy once, leaving source/text handling to Hjem
{ lib }:
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
// lib.optionalAttrs (private || mutable) {
  permissions =
    if private then
      if executable then "0700" else "0600"
    else if executable then
      "0755"
    else
      "0644";
}
