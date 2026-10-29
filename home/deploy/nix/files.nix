{
  pkgs,
  inputs,
  home,
  repository,
  os,
  environment ? { },
}:
let
  inherit (pkgs) lib stdenv;
  palette = (lib.importJSON ../../theme/palette/palette.json).catppuccin_custom;
  ompDependencies =
    (lib.importJSON "${inputs.ai}/apps/omp/runtime/upstream/package.json").dependencies;
  manifest = import ../../manifest.nix;
  normalizeFile = import ./file/entry.nix { inherit lib; };
  components =
    color:
    map (offset: lib.fromHexString (lib.substring offset 2 color)) [
      1
      3
      5
    ];
  rgb = color: "rgb(${lib.concatMapStringsSep ", " toString (components color)})";
  byteHex = value: lib.toLower (lib.fixedWidthString 2 "0" (lib.toHexString value));
  # Mix 85% background and 15% foreground with nearest-byte rounding
  surfaceMix =
    colors: color:
    let
      channels = lib.zipListsWith (
        background: foreground: byteHex (lib.div (background * 85 + foreground * 15 + 50) 100)
      ) (components colors.terminalBackground) (components color);
    in
    "#${lib.concatStrings channels}";
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
      # Inherit the deployed extension dependency from the locked AI runtime
      name = "@OMP_PI_TUI_VERSION@";
      value = ompDependencies."@oh-my-pi/pi-tui";
    }
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
      templateText = lib.replaceStrings [ "@GHOSTTY_COMMON@" "@GHOSTTY_KEY_TABLES@" ] (map
        (path: lib.removeSuffix "\n" (lib.readFile path))
        [
          ../../files/.config/ghostty/common.ghostty
          ../../files/.config/ghostty/key/tables.ghostty
        ]
      ) (lib.readFile (../../files + "/${source}"));
      variant = entry.variant or "dark";
      variantText =
        lib.replaceStrings
          [ "_VARIANT_" "catppuccin_custom_variant" ]
          [ "_${lib.toUpper variant}_" "catppuccin_custom_${variant}" ]
          templateText;
      text = replace (
        if source == ".config/eza/theme.yml" then
          lib.replaceStrings [ "_DARK_" ] [ "_${lib.toUpper variant}_" ] variantText
        else
          variantText
      );
    in
    normalizeFile entry (
      if entry.symlink or false then { source = lib.removeSuffix "\n" text; } else { inherit text; }
    );
  homebrewPath =
    append:
    normalizeFile { target = ".config/shell/homebrew-path${lib.optionalString append "-tail"}.sh"; } {
      text =
        lib.concatMapStrings
          (tool: ''_dotfiles_path_append_once "$HOMEBREW_PREFIX/opt/${tool.formula}/${tool.path}"'' + "\n")
          (
            lib.filter (tool: lib.elem "darwin" tool.platforms && (tool.append or false) == append) (
              lib.importJSON ../../../data/homebrew/tools.json
            )
          );
    };
in
map file (lib.filter enabled manifest.files)
++ lib.optionals (os == "darwin") [
  (homebrewPath false)
  (homebrewPath true)
]
