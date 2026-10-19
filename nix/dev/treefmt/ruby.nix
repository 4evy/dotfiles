{ pkgs }:
let
  rubyEnv = pkgs.bundlerEnv {
    ruby = pkgs.ruby_4_0;
    name = "dotfiles-ruby";
    gemfile = ../../../Gemfile;
    lockfile = ../../../Gemfile.lock;
    gemset = import ../gemset.nix;
  };

  rubocopFormatter = pkgs.writeShellApplication {
    name = "rubocop-format";
    runtimeEnv.GEM_PATH = "${rubyEnv}/${pkgs.ruby_4_0.gemPath}";
    text = ''
      exec ${rubyEnv}/bin/rubocop "$@"
    '';
  };
in
rubocopFormatter
