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
  # Preserve symlink leaves and omit empty directories, as Hjem needs files
  files =
    source: target:
    map (path: {
      source = path;
      target = "${target}/${lib.removePrefix "${toString source}/" (toString path)}";
    }) (lib.filesystem.listFilesRecursive source);
  font = {
    type = "symlink";
    source = inputs.source-noto-color-emoji.outPath;
    target = ".local/share/fonts/NotoColorEmoji/NotoColorEmoji.ttf";
  };
in
lib.concatMap (framework: files framework.source framework.target) frameworks
++ lib.optional (os == "darwin") font
