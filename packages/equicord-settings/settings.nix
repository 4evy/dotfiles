{ lib, parseRules }:
let
  inherit (lib.attrsets) mapAttrs' nameValuePair;

  capitalize = string: lib.toUpper (builtins.substring 0 1 string) + builtins.substring 1 (-1) string;

  pluginJsonName = name: parseRules.pluginRenames.${name} or (capitalize name);

  pluginToJson =
    plugin:
    (removeAttrs plugin [ "enable" ])
    // {
      enabled = plugin.enable or true;
    };

  enabledPlugins =
    lib.genAttrs
      [
        "alwaysExpandRoles"
        "betterGifPicker"
        "betterSettings"
        "betterUploadButton"
        "biggerStreamPreview"
        "clearUrls"
        "crashHandler"
        "disableCallIdle"
        "dontRoundMyTimestamps"
        "equicordHelper"
        "favoriteEmojiFirst"
        "fixCodeblockGap"
        "fixImagesQuality"
        "fixYoutubeEmbeds"
        "forceOwnerCrown"
        "fullSearchContext"
        "fullVcpfp"
        "gifPaste"
        "greetStickerPicker"
        "hideChatButtons"
        "hideMedia"
        "hideServers"
        "homeTyping"
        "imageFilename"
        "implicitRelationships"
        "lastActive"
        "limitlessScreenshare"
        "memberCount"
        "mentionAvatars"
        "messageLoggerEnhanced"
        "mutualGroupDms"
        "newGuildSettings"
        "newPluginsManager"
        "noBlockedMessages"
        "noDevtoolsWarning"
        "noF1"
        "noMaskedUrlPaste"
        "noMosaic"
        "noPendingCount"
        "noProfileThemes"
        "noTypingAnimation"
        "noUnblockToJump"
        "onePingPerDm"
        "pauseInvitesForever"
        "pictureInPicture"
        "platformIndicators"
        "previewMessage"
        "readAllNotificationsButton"
        "relationshipNotifier"
        "replyTimestamp"
        "revealAllSpoilers"
        "serverInfo"
        "serverListIndicators"
        "showBadgesInChat"
        "showConnections"
        "showHiddenThings"
        "showTimeoutDuration"
        "silentTyping"
        "streamerModeOnStream"
        "themeAttributes"
        "translate"
        "typingIndicator"
        "typingTweaks"
        "unindent"
        "unlockedAvatarZoom"
        "userVoiceShow"
        "validReply"
        "validUser"
        "viewIcons"
        "voiceChatDoubleClick"
        "volumeBooster"
        "youtubeAdblock"
      ]
      (_: {
        enable = true;
      });

  nixcordConfig = {
    useQuickCss = true;
    plugins = enabledPlugins // {
      callTimer = {
        enable = true;
        format = "human";
      };
      ignoreActivities = {
        enable = true;
        ignoreCompeting = true;
        ignoreListening = false;
        ignorePlaying = true;
        ignoreWatching = true;
      };
      messageLogger = {
        enable = true;
        collapseDeleted = true;
        ignoreBots = true;
        ignoreSelf = true;
      };
      questify = {
        enable = true;
        migrationVersion = 1;
        disableQuestsEverything = false;
        questButtonDisplay = "always";
        disableMembersListPromo = true;
        disableFriendsListPromo = true;
        disableRelocationNotices = true;
        disableSponsoredBanner = false;
        disableOrbsAndQuestsBadges = false;
        disableAccountPanelPromo = true;
        autoCompleteQuestTypes = {
          PLAY_ON_DESKTOP = true;
          PLAY_ON_XBOX = true;
          PLAY_ON_PLAYSTATION = true;
          PLAY_ACTIVITY = true;
          WATCH_VIDEO = true;
          WATCH_VIDEO_ON_MOBILE = true;
          ACHIEVEMENT_IN_ACTIVITY = true;
        };
        preventVideoQuestsPausing = true;
        disableAccountPanelQuestProgress = false;
        acknowledgedNotices = {
          "quest-ban-warning-2026-08-07" = true;
        };
        allowChangingDangerousSettings = true;
        isOnQuestsPage = true;
        newExcludedQuestAlertSound = null;
        newQuestAlertSound = "discodo";
        questFetchInterval = 2700;
        notifyOnNewExcludedQuests = false;
        notifyOnNewQuests = true;
        questButtonIndicator = "both";
        questButtonBadgeCount = 4;
        questButtonBadgeColor = 2842239;
        questButtonLeftClickAction = "open-quests";
        questButtonMiddleClickAction = "plugin-settings";
        questButtonRightClickAction = "context-menu";
        ignoredQuestIds.questIDs = [ ];
        questButtonIncludedTypes = {
          "1" = true;
          "2" = true;
          "3" = true;
          "4" = true;
          "5" = true;
          WATCH_VIDEO = true;
          WATCH_VIDEO_ON_MOBILE = true;
          ACHIEVEMENT_IN_ACTIVITY = true;
          ACHIEVEMENT_IN_GAME = true;
          PLAY_ACTIVITY = true;
          PLAY_ON_DESKTOP = true;
          PLAY_ON_DESKTOP_V2 = true;
          STREAM_ON_DESKTOP = true;
          PLAY_ON_PLAYSTATION = true;
          PLAY_ON_XBOX = true;
        };
        resumeInterruptedQuests = true;
        rememberQuestPageSort = true;
        lastQuestPageSort = "questify";
        rememberQuestPageFilters = true;
        lastQuestPageFilters = { };
        makeMobileVideoQuestsDesktopCompatible = true;
        unclaimedSubsort = "Expiring ASC";
        claimedSubsort = "Claimed DESC";
        ignoredSubsort = "Recent DESC";
        expiredSubsort = "Expiring DESC";
        questOrder = [
          "UNCLAIMED"
          "CLAIMED"
          "IGNORED"
          "EXPIRED"
        ];
        questTileUnclaimedColor = {
          enabled = true;
          color = 2842239;
        };
        questTileClaimedColor = {
          enabled = true;
          color = 6105983;
        };
        questTileIgnoredColor = {
          enabled = true;
          color = 8334124;
        };
        questTileExpiredColor = {
          enabled = true;
          color = 2368553;
        };
        questTileGradient = "intense";
        questTilePreload = true;
        newQuestAlertVolume = 100;
        newExcludedQuestAlertVolume = 100;
        notifyOnQuestComplete = true;
        questCompletedAlertSound = "bop_message1";
        questCompletedAlertVolume = 100;
        completeVideoQuestsQuicker = true;
        autoCompleteQuestsSimultaneously = true;
        resumeQuestIds = { };
      };
    };
  };

  jsonConfig = nixcordConfig // {
    plugins = mapAttrs' (
      name: plugin: nameValuePair (pluginJsonName name) (pluginToJson plugin)
    ) nixcordConfig.plugins;
  };
in
{
  inherit
    jsonConfig
    nixcordConfig
    ;
}
