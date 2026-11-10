_:
let
  # Finder replaces this dictionary, so retain usable icon and label geometry
  iconViewSettings = {
    arrangeBy = "name";
    backgroundType = 0;
    backgroundColorRed = 1.0;
    backgroundColorGreen = 1.0;
    backgroundColorBlue = 1.0;
    gridOffsetX = 0.0;
    gridOffsetY = 0.0;
    gridSpacing = 54.0;
    iconSize = 64.0;
    labelOnBottom = true;
    showIconPreview = true;
    showItemInfo = false;
    textSize = 12.0;
    viewOptionsVersion = 1;
  };
in
{
  system.defaults = {
    LaunchServices = {
      LSQuarantine = false;
    };
    SoftwareUpdate = {
      AutomaticallyInstallMacOSUpdates = false;
    };
    NSGlobalDomain = {
      KeyRepeat = 2;
      AppleMetricUnits = 1;
      AppleInterfaceStyleSwitchesAutomatically = true;
      NSAutomaticWindowAnimationsEnabled = false;
      NSDocumentSaveNewDocumentsToCloud = false;
      NSAutomaticCapitalizationEnabled = false;
      NSAutomaticSpellingCorrectionEnabled = false;
      NSAutomaticPeriodSubstitutionEnabled = false;
      NSAutomaticDashSubstitutionEnabled = false;
      NSAutomaticQuoteSubstitutionEnabled = false;
    };
    menuExtraClock = {
      Show24Hour = true;
      ShowSeconds = true;
      ShowDate = 2;
    };
    finder = {
      AppleShowAllFiles = false;
      AppleShowAllExtensions = true;
      FXEnableExtensionChangeWarning = false;
      FXPreferredViewStyle = "icnv";
      QuitMenuItem = true;
      ShowPathbar = true;
    };
    CustomUserPreferences."com.apple.finder" = {
      # Keep new icons packed by name instead of preserving free-form positions
      # Existing per-folder .DS_Store overrides need a one-time migration too
      StandardViewSettings.IconViewSettings = iconViewSettings;
      FK_StandardViewSettings.IconViewSettings = iconViewSettings;
      DesktopViewSettings.IconViewSettings = iconViewSettings;
    };
    dock = {
      autohide = true;
      magnification = false;
      orientation = "bottom";
      show-recents = false;
      showhidden = true;
      tilesize = 65;
      wvous-tl-corner = 1;
      wvous-tr-corner = 1;
      wvous-bl-corner = 1;
      wvous-br-corner = 1;
    };
  };
}
