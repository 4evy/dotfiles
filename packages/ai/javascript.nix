{
  ai-app-modules,
  ai-javascript,
  dotfilesPackageUpdaters,
  runCommand,
}:
let
  modules = ai-app-modules.overrideAttrs (old: {
    patches = (old.patches or [ ]) ++ [ ./omp-process-name.patch ];
    passthru = (old.passthru or { }) // {
      updateScript = dotfilesPackageUpdaters.flakeInputs [ "ai" ];
    };
  });
in
runCommand "ai-javascript-omp-process-name"
  {
    inherit (ai-javascript) meta;
    passthru = (ai-javascript.passthru or { }) // {
      # The upstream input owns the JavaScript sources and dependency hashes
      updateScript = dotfilesPackageUpdaters.flakeInputs [ "ai" ];
    };
  }
  ''
    mkdir -p "$out"
    cp -rs ${ai-javascript}/. "$out/"
    find "$out" -type d -exec chmod u+w {} +
    # Keep matching Vite chunks together while retaining shared runtime packages
    cp -r --remove-destination ${modules}/. "$out/"
  ''
