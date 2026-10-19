{
  pkgs,
  inputs,
  environment ? { },
}:
let
  inherit (pkgs)
    lib
    runCommandLocal
    stdenv
    writeText
    writeTextFile
    ;
  configured =
    name: fallback:
    let
      value = environment.${name} or "";
    in
    if value != "" then value else fallback;
  home = configured "HOME" (if os == "darwin" then "/Users/evy" else "/var/home/evy");
  repository = configured "HJEM_WORKING_TREE" (
    if os == "darwin" then "/Users/evy/Developer/dotfiles" else "/var/home/evy/dotfiles"
  );
  brewPrefix = configured "HOMEBREW_PREFIX" (
    if os == "darwin" then "/opt/homebrew" else "/home/linuxbrew/.linuxbrew"
  );
  os = configured "HJEM_PLATFORM" (if stdenv.hostPlatform.isDarwin then "darwin" else "linux");
  metadata = lib.importJSON ../../dotfiles/manifest.json;
  enabled = entry: !(entry ? systems) || lib.elem os entry.systems;
  commandAvailable =
    name:
    lib.any (directory: lib.pathExists "${directory}/${name}") (
      lib.splitString ":" (environment.PATH or "")
    );
  substitute =
    lib.replaceStrings
      [ "@HOME@" "@REPOSITORY@" "@OS@" "@HOMEBREW_PREFIX@" ]
      [ home repository os brewPrefix ];
  sourceText = entry: substitute (lib.readFile (../../dotfiles/home + "/${entry.source}"));
  fileEntry =
    entry:
    {
      inherit (entry) target;
      executable = entry.executable or false;
      type = if (entry.private or false) || (entry.mutable or false) then "copy" else "symlink";
    }
    // (
      if entry.symlink or false then
        {
          source =
            let
              destination = lib.strings.trim (sourceText entry);
            in
            if lib.hasPrefix "/" destination then
              destination
            else
              "${dirOf "${home}/${entry.target}"}/${destination}";
        }
      else if lib.pathIsDirectory (../../dotfiles/home + "/${entry.source}") then
        # Keep module siblings together when runtimes resolve symlink targets
        { source = ../../dotfiles/home + "/${entry.source}"; }
      else
        { text = sourceText entry; }
    )
    // lib.optionalAttrs ((entry.private or false) || (entry.mutable or false)) {
      permissions =
        if entry.private or false then
          if entry.executable or false then "0700" else "0600"
        else if entry.executable or false then
          "0755"
        else
          "0644";
    };
  static = lib.filter (
    entry:
    enabled entry
    && !(entry.nixGenerated or false)
    && (!(entry ? requireCommand) || commandAvailable entry.requireCommand)
  ) metadata.files;
  applicationFiles = import ./files.nix {
    inherit
      pkgs
      home
      repository
      os
      environment
      ;
  };
  hooks = map (
    entry:
    let
      name = entry.name or entry.source;
      source = writeTextFile {
        name = "hjem-hook-${name}";
        executable = true;
        text = substitute (lib.readFile (../../dotfiles/hooks + "/${entry.source}"));
      };
    in
    {
      inherit name;
      source = toString source;
      onchange = entry.onChange or false;
      inputs = map substitute (entry.inputs or [ ]);
    }
  ) (lib.filter enabled metadata.hooks);
  generators = lib.importJSON ../../dotfiles/generators.json;
  manifest = writeText "hjem-manifest.json" (
    lib.toJSON (
      import ./manifest.nix {
        inherit pkgs inputs home;
        files =
          map fileEntry static
          ++ applicationFiles
          ++ import ./externals.nix {
            inherit inputs lib os;
          };
      }
    )
  );
  hookMetadata = writeText "hjem-hooks.json" (lib.toJSON hooks);
  generatorMetadata = writeText "hjem-generators.json" (lib.toJSON generators);
in
assert lib.assertMsg (
  home != "" && lib.hasPrefix "/" home
) "Hjem requires an absolute home directory";
assert lib.assertMsg (
  repository != "" && lib.hasPrefix "/" repository
) "Hjem requires an absolute checkout path";
runCommandLocal "hjem-home" { } ''
  mkdir -p "$out"
  cp ${manifest} "$out/manifest.json"
  cp ${hookMetadata} "$out/hooks.json"
  cp ${generatorMetadata} "$out/generators.json"
''
