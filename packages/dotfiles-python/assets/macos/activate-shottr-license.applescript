on run arguments
  set licenseCode to item 1 of arguments

  open location "shottr://settings/license"
  delay 0.5

  tell application "System Events"
    repeat 150 times
      if exists process "Shottr" then exit repeat
      delay 0.1
    end repeat

    tell process "Shottr"
      set frontmost to true
      repeat 150 times
        if exists window "Preferences" then exit repeat
        delay 0.1
      end repeat
      if not (exists window "Preferences") then error "Shottr preferences window did not appear"

      tell window "Preferences"
        if exists button "License" of toolbar 1 then click button "License" of toolbar 1
        delay 0.2

        if exists button "Change" of group 1 then
          click button "Change" of group 1
          delay 0.2
        end if

        set value of text field 1 of group 1 to licenseCode
        delay 0.2

        if exists button "Activate" of group 1 then
          click button "Activate" of group 1
        else
          error "Shottr activation button was not found"
        end if
      end tell
    end tell
  end tell
end run
