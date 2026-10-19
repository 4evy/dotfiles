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
  files =
    source: target:
    let
      entries = lib.readDir source;
      entry =
        name:
        let
          path = source + "/${name}";
          destination = "${target}/${name}";
        in
        if entries.${name} == "directory" then
          files path destination
        else
          [
            {
              source = path;
              target = destination;
            }
          ];
    in
    lib.concatMap entry (lib.attrNames entries);
  font = {
    type = "symlink";
    source = inputs.source-noto-color-emoji.outPath;
    target = ".local/share/fonts/NotoColorEmoji/NotoColorEmoji.ttf";
  };
in
lib.concatMap (framework: files framework.source framework.target) frameworks
++ lib.optional (os == "darwin") font
