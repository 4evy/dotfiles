{
  pkgs,
  inputs,
  home,
  repository,
  os,
  platform,
  environment ? { },
}:
let
  inherit (pkgs) lib stdenv;
  inherit
    (import ../../theme/palette {
      inherit inputs lib;
    })
    palette
    ;
  ompDependencies =
    (lib.trivial.importJSON "${inputs.ai}/apps/omp/runtime/upstream/package.json").dependencies;
  manifest = import ../../manifest.nix { inherit lib; };
  normalizeFile = import ./file/entry.nix { inherit lib; };
  configHome = environment.XDG_CONFIG_HOME or "";
  equicordSettings = pkgs.callPackage ../../applications/discord/equicord/package.nix {
    inherit inputs;
  };
  hexDigitsPerByte = 2;
  surfaceBackgroundPercent = 85;
  surfaceForegroundPercent = 15;
  percentScale = 100;
  nearestByteRounding = lib.trivial.div percentScale 2;

  /**
    Decode a `#rrggbb` color into its red, green, and blue byte values

    # Type
    `components :: String -> [Int]`

    # Examples
    `components "#ff0080"` returns `[ 255 0 128 ]`
  */
  components =
    color:
    lib.lists.map
      (offset: lib.trivial.fromHexString (lib.strings.substring offset hexDigitsPerByte color))
      [
        1
        3
        5
      ];

  /**
    Convert a `#rrggbb` color to CSS `rgb(...)` notation

    # Type
    `rgb :: String -> String`

    # Examples
    `rgb "#ff0080"` returns `"rgb(255, 0, 128)"`
  */
  rgb = color: "rgb(${lib.strings.concatMapStringsSep ", " toString (components color)})";

  /**
    Format a byte as two lowercase hexadecimal digits

    # Type
    `byteHex :: Int -> String`

    # Examples
    `byteHex 10` returns `"0a"`
  */
  byteHex =
    value:
    lib.strings.toLower (
      lib.strings.fixedWidthString hexDigitsPerByte "0" (lib.trivial.toHexString value)
    );

  /**
    Mix 85% of `colors.terminalBackground` with 15% of the foreground color,
    rounding each channel to the nearest byte

    # Type
    `surfaceMix :: { terminalBackground: String, ... } -> String -> String`

    # Examples
    `surfaceMix { terminalBackground = "#000000"; } "#ffffff"` returns `"#262626"`
  */
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
          lib.lists.map
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

  /**
    Find the first existing path for a name in the supplied host `PATH`

    # Type
    `commandPath :: String -> (String | Null)`

    # Examples
    With an empty or missing `PATH`, `commandPath "ssh"` returns `null`
  */
  commandPath =
    name:
    lib.lists.findFirst lib.trivial.pathExists null (
      lib.lists.map (directory: "${directory}/${name}") (
        lib.lists.filter (directory: directory != "") (lib.strings.splitString ":" (environment.PATH or ""))
      )
    );

  /**
    Return a command's path, or leave its name for runtime lookup

    # Type
    `findCommand :: String -> String`

    # Examples
    With an empty `PATH`, `findCommand "python3.15"` returns `"python3.15"`
  */
  findCommand = name: lib.trivial.defaultTo name (commandPath name);

  /**
    Return the first resolved command from an ordered list, or the fallback

    # Type
    `firstCommand :: [String] -> String -> String`

    # Examples
    `firstCommand [ ] "clang-tidy"` returns `"clang-tidy"`
  */
  firstCommand =
    names: fallback:
    lib.lists.findFirst (path: path != null) fallback (lib.lists.map commandPath names);
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

  /**
    Expand color and runtime markers in a template

    # Type
    `replace :: String -> String`

    # Examples
    With `home = "/home/user"`, `replace "@HOME@"` returns `"/home/user"`
  */
  replace = lib.strings.replaceStrings (lib.attrsets.catAttrs "name" markers) (
    lib.attrsets.catAttrs "value" markers
  );

  /**
    Check whether an inventory entry needs Nix rendering on this platform

    # Type
    `enabled :: { nixGenerated?: Bool, systems?: [String], ... } -> Bool`

    # Examples
    `enabled { nixGenerated = true; }` returns `true` on any platform
  */
  enabled =
    entry:
    (entry.nixGenerated or false) && (entry.systems or [ ] == [ ] || lib.lists.elem os entry.systems);

  /**
    Render the platform template and palette variant into a Hjem file entry

    # Type
    `file :: AttrSet -> AttrSet`

    # Examples
    `(file { source = ".config/starship.toml"; target = ".config/starship.toml"; }).type`
    returns `"symlink"` and its `text` uses the default dark variant
  */
  file =
    entry:
    let
      source = (entry.sourceByOS or { }).${os} or entry.source;
      templateText = lib.trivial.readFile (../../files + "/${source}");
      variant = entry.variant or "dark";
      variantText =
        lib.strings.replaceStrings
          [
            "_VARIANT_"
            "catppuccin_custom_variant"
            "@THEME_VARIANT@"
            "@CIDER_SCROLLBAR_MIX@"
            "@CIDER_SCROLLBAR_THUMB_MIX@"
            "@CIDER_POWERSWOOSH_FOREGROUND@"
          ]
          [
            "_${lib.strings.toUpper variant}_"
            "catppuccin_custom_${variant}"
            variant
            (if variant == "light" then "48" else "52")
            (if variant == "light" then "44" else "50")
            (if variant == "light" then "var(--crust)" else "var(--text)")
          ]
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

  /**
    Render the Homebrew paths for the early or tail segment of the shell path

    # Type
    `homebrewPath :: Bool -> AttrSet`

    # Examples
    `(homebrewPath true).target` returns `".config/shell/homebrew-path-tail.sh"`
  */
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
lib.lists.map file (lib.lists.filter enabled manifest.files)
++ [
  (normalizeFile { target = ".local/bin/rex"; } {
    source = lib.meta.getExe pkgs.rex;
  })
]
++
  lib.lists.map
    (
      target:
      normalizeFile { inherit target; } {
        source = "${pkgs.rex}/share/rex/skills/rex/SKILL.md";
      }
    )
    [
      ".agents/skills/rex/SKILL.md"
      ".claude/skills/rex/SKILL.md"
    ]
++
  lib.lists.map
    (
      entry:
      normalizeFile { target = ".terminfo/${entry}"; } {
        source = "${pkgs.rex}/share/terminfo/${entry}";
      }
    )
    [
      "x/xterm-rex"
      "78/xterm-rex"
      "r/rex"
      "72/rex"
    ]
++ lib.lists.optionals (platform == "linux") (
  # Nixcord owns this projection on NixOS. On standalone Linux Equicord
  # writes both files in place, so install writable copies rather than links
  lib.lists.map
    (
      name:
      normalizeFile
        {
          target = "Equicord/settings/${name}";
          mutable = true;
        }
        {
          relativeTo = if lib.strings.hasPrefix "/" configHome then configHome else "${home}/.config";
          source = "${equicordSettings}/${name}";
        }
    )
    [
      "settings.json"
      "quickCss.css"
    ]
)
++ lib.lists.optionals (os == "darwin") [
  (homebrewPath false)
  (homebrewPath true)
  (normalizeFile { target = ".config/rex/palette.json"; } {
    text = lib.strings.toJSON {
      inherit (palette) light dark;
    };
  })
]
