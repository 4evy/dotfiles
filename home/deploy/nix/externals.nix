{
  inputs,
  lib,
  os,
}:
let
  frameworks = [
    {
      source = inputs.source-oh-my-zsh.outPath;
      target = ".oh-my-zsh";
    }
    {
      source = inputs.source-zsh-autosuggestions.outPath;
      target = ".oh-my-zsh/custom/plugins/zsh-autosuggestions";
    }
    {
      source = inputs.source-zsh-syntax-highlighting.outPath;
      target = ".oh-my-zsh/custom/plugins/zsh-syntax-highlighting";
    }
    {
      source = inputs.source-fzf-tab.outPath;
      target = ".oh-my-zsh/custom/plugins/fzf-tab";
    }
    {
      source = inputs.source-oh-my-bash.outPath;
      target = ".oh-my-bash";
    }
    {
      source = inputs.source-fzf-tab-completion.outPath;
      target = ".fzf-tab-completion";
    }
  ];
  /**
    Map every leaf under `source` into a home-relative `target` directory

    Symlink leaves are preserved and empty directories are omitted

    # Type
    `files :: Path -> String -> [{ source: Path, target: String }]`

    # Examples
    If `./plugin` contains only `init.zsh`, `files ./plugin ".plugin"` returns
    `[ { source = ./plugin/init.zsh; target = ".plugin/init.zsh"; } ]`
  */
  files =
    source: target:
    lib.lists.map (path: {
      source = path;
      target = "${target}/${lib.strings.removePrefix "${toString source}/" (toString path)}";
    }) (lib.filesystem.listFilesRecursive source);
  font = {
    type = "symlink";
    source = inputs.source-noto-color-emoji.outPath;
    target = ".local/share/fonts/NotoColorEmoji/NotoColorEmoji.ttf";
  };
in
lib.lists.concatMap (framework: files framework.source framework.target) frameworks
++ lib.lists.optional (os == "darwin") font
