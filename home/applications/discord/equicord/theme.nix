{
  lib,
  palette,
  exceptions,
}:
let
  modernSteps = lib.lists.range 1 100;
  legacySteps = [
    100
    130
    160
    200
    230
    260
    300
    330
    345
    360
    400
    430
    460
    500
    530
    560
    600
    630
    645
    660
    700
    730
    760
    800
    830
    860
    900
  ];

  /**
    Mark a color at a step on a Discord scale

    # Type
    `anchor :: Int -> String -> { at: Int, color: String }`

    # Examples
    `anchor 50 "#000000"` returns `{ at = 50; color = "#000000"; }`
  */
  anchor = at: color: { inherit at color; };
  neutralAnchors = {
    light = [
      (anchor 1 palette.light.surface)
      (anchor 2 palette.light.base)
      (anchor 4 palette.light.highlightLow)
      (anchor 7 palette.light.crust)
      (anchor 10 palette.light.overlay)
      (anchor 16 palette.light.highlightMed)
      (anchor 20 palette.light.surface1)
      (anchor 29 palette.light.highlightHigh)
      (anchor 34 palette.light.overlay0)
      (anchor 41 palette.light.overlay1)
      (anchor 47 palette.light.placeholder)
      (anchor 58 palette.light.subtext0)
      (anchor 66 palette.light.subtext1)
      (anchor 72 palette.light.text)
      (anchor 100 palette.dark.crust)
    ];
    dark = [
      (anchor 1 palette.light.surface)
      (anchor 4 palette.dark.text)
      (anchor 10 palette.dark.subtext1)
      (anchor 16 palette.dark.subtle)
      (anchor 23 palette.dark.placeholder)
      (anchor 27 palette.dark.overlay1)
      (anchor 40 palette.dark.highlightMed)
      (anchor 47 palette.dark.overlay0)
      (anchor 60 palette.dark.surface2)
      (anchor 62 palette.dark.surface1)
      (anchor 64 palette.dark.surface0)
      (anchor 66 palette.dark.surface)
      (anchor 69 palette.dark.mantle)
      (anchor 73 palette.dark.base)
      (anchor 78 palette.dark.crust)
      (anchor 100 palette.dark.surfaceOverlay)
    ];
  };

  /**
    Pair consecutive anchors in a nonempty ordered list

    # Type
    `adjacentAnchorPairs :: [Anchor] -> [{ lower: Anchor, upper: Anchor }]`

    # Examples
    `adjacentAnchorPairs [ a b c ]` returns
    `[ { lower = a; upper = b; } { lower = b; upper = c; } ]`
  */
  adjacentAnchorPairs =
    anchors:
    lib.lists.zipListsWith (lower: upper: { inherit lower upper; }) anchors (lib.lists.tail anchors);

  /**
    Return ordered anchors that cover all requested steps, or throw for `name`

    # Type
    `validateAnchors :: String -> [Int] -> [Anchor] -> [Anchor]`

    # Examples
    With `a.at = 1` and `b.at = 10`, `validateAnchors "red" [ 5 ] [ a b ]`
    returns `[ a b ]`
  */
  validateAnchors =
    name: steps: anchors:
    lib.trivial.throwIfNot (
      anchors != [ ]
      && (lib.lists.head anchors).at <= lib.lists.head steps
      && (lib.lists.last anchors).at >= lib.lists.last steps
      && lib.lists.all ({ lower, upper }: lower.at < upper.at) (adjacentAnchorPairs anchors)
    ) "Discord color scale ${name} must have ordered anchors covering every requested step" anchors;

  /**
    Select the interpolation interval for a step, clamping at the final anchor

    # Type
    `anchorPairAt :: [Anchor] -> Int -> { lower: Anchor, upper: Anchor }`

    # Examples
    If `b.at = 10`, `anchorPairAt [ a b ] 10` returns `{ lower = b; upper = b; }`
  */
  anchorPairAt =
    anchors: step:
    let
      final = lib.lists.last anchors;
    in
    lib.lists.findFirst ({ upper, ... }: step < upper.at) {
      lower = final;
      upper = final;
    } (adjacentAnchorPairs anchors);

  /**
    Return an exact anchor color or a CSS interpolation for the requested step

    # Type
    `colorAt :: [Anchor] -> Int -> String`

    # Examples
    `colorAt [ (anchor 1 "#ffffff") (anchor 3 "#000000") ] 2` returns
    `"color-mix(in oklab, #ffffff 50%, #000000)"`
  */
  colorAt =
    anchors: step:
    let
      inherit (anchorPairAt anchors step) lower upper;
      lowerWeight =
        if lower.at == upper.at then
          100
        else
          lib.trivial.div ((upper.at - step) * 100) (upper.at - lower.at);
    in
    if step == lower.at || lower.at == upper.at then
      lower.color
    else
      "color-mix(in oklab, ${lower.color} ${toString lowerWeight}%, ${upper.color})";

  /**
    Emit custom CSS properties for named steps covered by the given anchors

    # Type
    `scaleDeclarations :: String -> [Int] -> [Anchor] -> String`

    # Examples
    `scaleDeclarations "red" [ 1 ] [ (anchor 1 "#f00") ]` returns
    `"  --red-1: #f00;"`
  */
  scaleDeclarations =
    name: steps: anchors:
    let
      checkedAnchors = validateAnchors name steps anchors;
    in
    lib.strings.concatMapStringsSep "\n" (
      step: "  --${name}-${toString step}: ${colorAt checkedAnchors step};"
    ) steps;

  /**
    Emit CSS for each named scale at the same set of steps

    # Type
    `scaleGroupDeclarations :: [Int] -> AttrSet [Anchor] -> String`

    # Examples
    `scaleGroupDeclarations [ 1 ] { red = [ (anchor 1 "#f00") ]; }`
    returns `"  --red-1: #f00;"`
  */
  scaleGroupDeclarations =
    steps: scales: lib.strings.concatMapAttrsStringSep "\n" (name: scaleDeclarations name steps) scales;

  /**
    Emit a CSS custom property for each named application color

    # Type
    `paletteDeclarations :: AttrSet String -> String`

    # Examples
    `paletteDeclarations { accent = "#fac"; }` returns
    `"  --catppuccin-custom-accent: #fac;"`
  */
  paletteDeclarations =
    colors:
    lib.strings.concatMapAttrsStringSep "\n" (
      role: color: "  --catppuccin-custom-${role}: ${color};"
    ) colors;

  /**
    Place a palette role halfway along Discord's modern scale for `variant`

    # Type
    `accentAnchors :: String -> String -> [Anchor]`

    # Examples
    `lib.lists.elemAt (accentAnchors "dark" "blue") 1` returns
    `{ at = 50; color = palette.dark.blue; }`
  */
  accentAnchors = variant: role: [
    (anchor 1 (if variant == "light" then palette.light.surface else palette.dark.text))
    (anchor 50 palette.${variant}.${role})
    (anchor 100 palette.dark.crust)
  ];

  /**
    Place a palette role at `center` on a legacy scale for `variant`

    # Type
    `legacyAccentAnchors :: String -> String -> Int -> [Anchor]`

    # Examples
    `lib.lists.elemAt (legacyAccentAnchors "dark" "blue" 400) 1` returns
    `{ at = 400; color = palette.dark.blue; }`
  */
  legacyAccentAnchors = variant: role: center: [
    (anchor 100 (if variant == "light" then palette.light.surface else palette.dark.text))
    (anchor center palette.${variant}.${role})
    (anchor 900 palette.dark.crust)
  ];

  /**
    Stretch one variant's neutral anchors from the modern to the legacy range

    # Type
    `legacyNeutralAnchors :: String -> [Anchor]`

    # Examples
    `(lib.lists.head (legacyNeutralAnchors "light")).at` returns `100`
  */
  legacyNeutralAnchors =
    variant:
    lib.lists.map (
      { at, color }:
      anchor (100 + lib.trivial.div ((at - 1) * 800) 99) color
    ) neutralAnchors.${variant};

  /**
    Collect Discord's modern color scales for one palette variant

    # Type
    `modernScales :: String -> AttrSet [Anchor]`

    # Examples
    `(modernScales "light").neutral` returns `neutralAnchors.light`
  */
  modernScales = variant: {
    "blue-new" = accentAnchors variant "blue";
    "green-new" = accentAnchors variant "green";
    neutral = neutralAnchors.${variant};
    blurple = accentAnchors variant "accent";
    "orange-new" = accentAnchors variant "peach";
    pink = accentAnchors variant "pink";
    "red-new" = accentAnchors variant "red";
    "teal-new" = accentAnchors variant "teal";
    "yellow-new" = accentAnchors variant "yellow";
  };

  /**
    Collect the legacy scales that still feed Discord's semantic tokens

    # Type
    `legacyScales :: String -> AttrSet [Anchor]`

    # Examples
    `(legacyScales "dark").primary` returns `legacyNeutralAnchors "dark"`
  */
  legacyScales = variant: {
    primary = legacyNeutralAnchors variant;
    brand = legacyAccentAnchors variant "accent" 500;
    red = legacyAccentAnchors variant "red" 400;
    green = legacyAccentAnchors variant "green" 400;
    yellow = legacyAccentAnchors variant "yellow" 400;
    teal = legacyAccentAnchors variant "teal" 400;
  };

  /**
    Render application roles and both sets of Discord scales for a variant

    # Type
    `variantDeclarations :: String -> String`

    # Examples
    `lib.strings.hasInfix "--neutral-1:" (variantDeclarations "light")`
    returns `true`
  */
  variantDeclarations = variant: ''
    ${paletteDeclarations palette.${variant}}
    --catppuccin-custom-brand: var(--catppuccin-custom-accent);
    --catppuccin-custom-positive: var(--catppuccin-custom-success);
    --catppuccin-custom-positive-foreground: var(--catppuccin-custom-successForeground);
    --catppuccin-custom-critical: var(--catppuccin-custom-error);
    --catppuccin-custom-critical-foreground: var(--catppuccin-custom-errorForeground);

    /* Discord's modern neutral, branded, and status foundations. */
    ${scaleGroupDeclarations modernSteps (modernScales variant)}

    /* Legacy foundations still consumed by semantic and plugin tokens. */
    ${scaleGroupDeclarations legacySteps (legacyScales variant)}
  '';
in
''
  /*
   * Catppuccin Custom for Discord
   *
   * Generated from Catppuccin Custom's application roles. Discord's native theme
   * classes map semantic tokens onto these foundations, so new components
   * inherit the palette without component-class patches.
   */

  .visual-refresh.theme-light,
  .visual-refresh .theme-light {
  ${variantDeclarations "light"}
  }

  .visual-refresh.theme-dark,
  .visual-refresh .theme-dark,
  .visual-refresh.theme-darker,
  .visual-refresh .theme-darker,
  .visual-refresh.theme-midnight,
  .visual-refresh .theme-midnight {
  ${variantDeclarations "dark"}
  }

  ${exceptions}
''
