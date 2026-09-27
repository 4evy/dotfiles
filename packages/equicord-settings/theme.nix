{
  lib,
  palette,
  exceptions,
}:
let
  inherit (lib)
    all
    concatMapAttrsStringSep
    concatMapStringsSep
    findFirst
    head
    last
    range
    tail
    throwIfNot
    zipListsWith
    ;

  modernSteps = range 1 100;
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

  adjacentAnchorPairs =
    anchors: zipListsWith (lower: upper: { inherit lower upper; }) anchors (tail anchors);
  validateAnchors =
    name: steps: anchors:
    throwIfNot (
      anchors != [ ]
      && (head anchors).at <= head steps
      && (last anchors).at >= last steps
      && all ({ lower, upper }: lower.at < upper.at) (adjacentAnchorPairs anchors)
    ) "Discord color scale ${name} must have ordered anchors covering every requested step" anchors;
  anchorPairAt =
    anchors: step:
    let
      final = last anchors;
    in
    findFirst ({ upper, ... }: step < upper.at) {
      lower = final;
      upper = final;
    } (adjacentAnchorPairs anchors);
  colorAt =
    anchors: step:
    let
      inherit (anchorPairAt anchors step) lower upper;
      lowerWeight =
        if lower.at == upper.at then 100 else builtins.div ((upper.at - step) * 100) (upper.at - lower.at);
    in
    if step == lower.at || lower.at == upper.at then
      lower.color
    else
      "color-mix(in oklab, ${lower.color} ${toString lowerWeight}%, ${upper.color})";

  scaleDeclarations =
    name: steps: anchors:
    let
      checkedAnchors = validateAnchors name steps anchors;
    in
    concatMapStringsSep "\n" (
      step: "  --${name}-${toString step}: ${colorAt checkedAnchors step};"
    ) steps;
  scaleGroupDeclarations =
    steps: scales: concatMapAttrsStringSep "\n" (name: scaleDeclarations name steps) scales;
  paletteDeclarations =
    colors:
    concatMapAttrsStringSep "\n" (role: color: "  --catppuccin-custom-${role}: ${color};") colors;

  accentAnchors = variant: role: [
    (anchor 1 (if variant == "light" then palette.light.surface else palette.dark.text))
    (anchor 50 palette.${variant}.${role})
    (anchor 100 palette.dark.crust)
  ];
  legacyAccentAnchors = variant: role: center: [
    (anchor 100 (if variant == "light" then palette.light.surface else palette.dark.text))
    (anchor center palette.${variant}.${role})
    (anchor 900 palette.dark.crust)
  ];
  legacyNeutralAnchors =
    variant:
    map (
      { at, color }:
      anchor (100 + builtins.div ((at - 1) * 800) 99) color
    ) neutralAnchors.${variant};

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
  legacyScales = variant: {
    primary = legacyNeutralAnchors variant;
    brand = legacyAccentAnchors variant "accent" 500;
    red = legacyAccentAnchors variant "red" 400;
    green = legacyAccentAnchors variant "green" 400;
    yellow = legacyAccentAnchors variant "yellow" 400;
    teal = legacyAccentAnchors variant "teal" 400;
  };

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
