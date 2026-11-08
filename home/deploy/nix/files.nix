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
  palette = (lib.trivial.importJSON ../../theme/palette/palette.json).catppuccin_custom;
  ompDependencies =
    (lib.trivial.importJSON "${inputs.ai}/apps/omp/runtime/upstream/package.json").dependencies;
  manifest = import ../../manifest.nix;
  normalizeFile = import ./file/entry.nix { inherit lib; };
  hexDigitsPerByte = 2;
  surfaceBackgroundPercent = 85;
  surfaceForegroundPercent = 15;
  percentScale = 100;
  nearestByteRounding = lib.trivial.div percentScale 2;
  components =
    color:
    map (offset: lib.trivial.fromHexString (lib.strings.substring offset hexDigitsPerByte color)) [
      1
      3
      5
    ];
  rgb = color: "rgb(${lib.strings.concatMapStringsSep ", " toString (components color)})";
  byteHex =
    value:
    lib.strings.toLower (
      lib.strings.fixedWidthString hexDigitsPerByte "0" (lib.trivial.toHexString value)
    );
  # Round the weighted channel average to the nearest byte
  surfaceMix =
    colors: color:
    let
      channels = lib.lists.zipListsWith (
        background: foreground:
        byteHex (
          lib.trivial.div (
            background * surfaceBackgroundPercent + foreground * surfaceForegroundPercent + nearestByteRounding
          ) percentScale
        )
      ) (components colors.terminalBackground) (components color);
    in
    "#${lib.strings.concatStrings channels}";
  colorMarkers =
    lib.lists.concatMap
      (
        variant:
        lib.lists.concatMap (
          key:
          let
            label = "${lib.strings.toUpper variant}_${lib.strings.toUpper key}";
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
        ) (lib.attrsets.attrNames palette.${variant})
        ++
          map
            (role: {
              name = "@MIX_${lib.strings.toUpper variant}_${lib.strings.toUpper role}@";
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
    lib.lists.findFirst lib.trivial.pathExists null (
      map (directory: "${directory}/${name}") (
        lib.lists.filter (directory: directory != "") (lib.strings.splitString ":" (environment.PATH or ""))
      )
    );
  findCommand = name: lib.trivial.defaultTo name (commandPath name);
  firstCommand =
    names: fallback: lib.lists.findFirst (path: path != null) fallback (map commandPath names);
  markers = colorMarkers ++ [
    {
      # Inherit the deployed extension dependency from the locked AI runtime
      name = "@OMP_PI_TUI_VERSION@";
      value = ompDependencies."@oh-my-pi/pi-tui";
    }
    {
      name = "@PYTHON@";
      value = findCommand "python3.15";
    }
    {
      name = "@CLANG_TIDY@";
      value = firstCommand [ "clang-tidy" ] (
        if lib.trivial.pathExists "/opt/homebrew/opt/llvm/bin/clang-tidy" then
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
      name = "@OMP_CLI@";
      value = lib.meta.getExe' pkgs.aiTools.ai-tools "omp";
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
      value = lib.strings.concatStrings [
        "{"
        "{.text}"
        "}"
      ];
    }
  ];
  replace = lib.strings.replaceStrings (lib.attrsets.catAttrs "name" markers) (
    lib.attrsets.catAttrs "value" markers
  );
  enabled =
    entry:
    (entry.nixGenerated or false) && (entry.systems or [ ] == [ ] || lib.lists.elem os entry.systems);
  file =
    entry:
    let
      source = (entry.sourceByOS or { }).${os} or entry.source;
      templateText = lib.trivial.readFile (../../files + "/${source}");
      variant = entry.variant or "dark";
      variantText =
        lib.strings.replaceStrings
          [ "_VARIANT_" "catppuccin_custom_variant" ]
          [ "_${lib.strings.toUpper variant}_" "catppuccin_custom_${variant}" ]
          templateText;
      text = replace (
        if source == ".config/eza/theme.yml" then
          lib.strings.replaceString "_DARK_" "_${lib.strings.toUpper variant}_" variantText
        else
          variantText
      );
    in
    normalizeFile entry (
      if entry.symlink or false then
        { source = lib.strings.removeSuffix "\n" text; }
      else
        { inherit text; }
    );
  homebrewPath =
    append:
    normalizeFile
      { target = ".config/shell/homebrew-path${lib.strings.optionalString append "-tail"}.sh"; }
      {
        text =
          lib.strings.concatMapStrings
            (tool: ''_dotfiles_path_append_once "$HOMEBREW_PREFIX/opt/${tool.formula}/${tool.path}"'' + "\n")
            (
              lib.lists.filter (
                tool: lib.lists.elem "darwin" tool.platforms && (tool.append or false) == append
              ) (lib.trivial.importJSON ../../../data/homebrew/tools.json)
            );
      };
in
map file (lib.lists.filter enabled manifest.files)
++ lib.lists.optionals (os == "darwin") [
  (homebrewPath false)
  (homebrewPath true)
  (normalizeFile { target = ".config/rex/palette.json"; } {
    text = builtins.toJSON {
      inherit (palette) light dark;
    };
  })
]
