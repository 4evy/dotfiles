_: {
  networking.networkmanager.enable = true;
  networking.networkmanager.ensureProfiles.profiles.ethernet = {
    connection = {
      id = "ethernet";
      type = "ethernet";
    };
    ipv4.method = "auto";
  };
}
