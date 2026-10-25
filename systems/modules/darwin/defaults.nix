_: {
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
