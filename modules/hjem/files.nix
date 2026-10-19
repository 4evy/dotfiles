{
  pkgs,
  home,
  repository,
  os,
  environment ? { },
}:
let
  inherit (pkgs) lib stdenv;
  palette = (lib.importJSON ../../dotfiles/data/palette/palette.json).catppuccin_custom;
  manifest = lib.importJSON ../../dotfiles/manifest.json;
  components =
    color:
    map (offset: lib.fromHexString (lib.substring offset 2 color)) [
      1
      3
      5
    ];
  rgb = color: "rgb(${lib.concatMapStringsSep ", " toString (components color)})";
  byteHex = value: lib.toLower (lib.fixedWidthString 2 "0" (lib.toHexString value));
  surfaceMix =
    colors: color:
    let
      background = components colors.terminalBackground;
      foreground = components color;
      channel =
        index: lib.div (lib.elemAt background index * 85 + lib.elemAt foreground index * 15 + 50) 100;
    in
    "#${
      lib.concatMapStrings (index: byteHex (channel index)) [
        0
        1
        2
      ]
    }";
  colorMarkers =
    lib.concatMap
      (
        variant:
        lib.concatMap (
          key:
          let
            label = "${lib.toUpper variant}_${lib.toUpper key}";
            color = palette.${variant}.${key};
          in
          [
            {
              name = "@COLOR_${label}@";
              value = color;
            }
            {
              name = "@RGB_${label}@";
              value = rgb color;
            }
          ]
        ) (lib.attrNames palette.${variant})
        ++
          map
            (role: {
              name = "@MIX_${lib.toUpper variant}_${lib.toUpper role}@";
              value = surfaceMix palette.${variant} palette.${variant}.${role};
            })
            [
              "success"
              "error"
            ]
      )
      [
        "light"
        "dark"
      ];
  commandPath =
    name:
    lib.findFirst lib.pathExists null (
      map (directory: "${directory}/${name}") (
        lib.filter (directory: directory != "") (lib.splitString ":" (environment.PATH or ""))
      )
    );
  findCommand =
    name:
    let
      path = commandPath name;
    in
    if path == null then name else path;
  firstCommand = names: fallback: lib.findFirst (path: path != null) fallback (map commandPath names);
  markers = colorMarkers ++ [
    {
      name = "@PYTHON@";
      value = findCommand "python3.14";
    }
    {
      name = "@CLANG_TIDY@";
      value = firstCommand [ "clang-tidy" ] (
        if lib.pathExists "/opt/homebrew/opt/llvm/bin/clang-tidy" then
          "/opt/homebrew/opt/llvm/bin/clang-tidy"
        else
          "clang-tidy"
      );
    }
    {
      name = "@NIX_SERVER@";
      value = firstCommand [ "vscode-nixd" "nixd" "nil" ] "nixd";
    }
    {
      name = "@NIXFMT@";
      value = firstCommand [ "vscode-nixfmt" "nixfmt" ] "nixfmt";
    }
    {
      name = "@HOME@";
      value = home;
    }
    {
      name = "@REPOSITORY@";
      value = repository;
    }
    {
      name = "@CODEX_NATIVE_CLI@";
      value =
        let
          arm = stdenv.hostPlatform.isAarch64;
          packageArch = if arm then "arm64" else "x64";
          targetArch = if arm then "aarch64" else "x86_64";
          targetOS = if os == "darwin" then "apple-darwin" else "unknown-linux-musl";
        in
        "${home}/.bun/install/global/node_modules/@openai/codex-${os}-${packageArch}/vendor/${targetArch}-${targetOS}/bin/codex";
    }
    {
      name = "@GLAMOUR_TEXT@";
      value = lib.concatStrings [
        "{"
        "{.text}"
        "}"
      ];
    }
  ];
  replace = lib.replaceStrings (map (item: item.name) markers) (map (item: item.value) markers);
  enabled =
    entry: (entry.nixGenerated or false) && (entry.systems or [ ] == [ ] || lib.elem os entry.systems);
  file =
    entry:
    let
      source = (entry.sourceByOS or { }).${os} or entry.source;
      text = replace (lib.readFile (../../dotfiles/home + "/${source}"));
      private = entry.private or false;
      executable = entry.executable or false;
    in
    {
      inherit (entry) target;
      inherit executable;
      type = if private then "copy" else "symlink";
    }
    // (if entry.symlink or false then { source = lib.removeSuffix "\n" text; } else { inherit text; })
    // lib.optionalAttrs private {
      permissions = if executable then "0700" else "0600";
    };
in
map file (lib.filter enabled manifest.files)
