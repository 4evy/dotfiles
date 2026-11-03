{
  ai-app-modules,
  ai-javascript,
  runCommand,
}:
let
  modules = ai-app-modules.overrideAttrs (old: {
    patches = (old.patches or [ ]) ++ [ ./omp-process-name.patch ];
  });
in
runCommand "ai-javascript-omp-process-name" { inherit (ai-javascript) meta; } ''
  mkdir -p "$out"
  cp -rs ${ai-javascript}/. "$out/"
  find "$out" -type d -exec chmod u+w {} +
  # Keep matching Vite chunks together while retaining shared runtime packages
  cp -r --remove-destination ${modules}/. "$out/"
''
