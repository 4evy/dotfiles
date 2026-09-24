# Apply chezmoi-managed dotfiles.
[arg('targets', help='Optional target paths to apply')]
[group('setup')]
apply *targets: (doctor 'apply')
    chezmoi \
      --source {{ quote(repo_dir) }} \
      --refresh-externals=auto \
      {{ quote(if targets { ['apply', targets] } else { ['init', '--apply'] }) }}

# Preview pending chezmoi-managed dotfile changes without refreshing externals.
[group('setup')]
dotfiles-diff: (doctor 'apply')
    chezmoi \
      --source {{ quote(repo_dir) }} \
      --refresh-externals=never \
      diff

# Apply Helium extensions and settings; quit Helium first so profile writes run.
[group('setup')]
helium: (doctor 'setup')
    ansible/bootstrap.sh --tags helium

[doc('Bootstrap userland, apply dotfiles, then apply host stages.')]
[group('setup')]
setup: (doctor 'setup')
    ansible/bootstrap.sh --setup

# Refresh userland, dotfiles, and host stages on an already-bootstrapped machine.
[group('setup')]
update: _userland apply _host

_deps:
    ansible-galaxy collection install {{ if !path_exists('.ansible/collections/ansible_collections/community/general/MANIFEST.json') || !path_exists('.ansible/collections/ansible_collections/community/sops/MANIFEST.json') { '--force' } }} \
      --requirements-file ansible/requirements.yml

_userland:
    DOTFILES_HOMEBREW_UPGRADE=1 ansible/bootstrap.sh --tags userland

_host:
    ansible/bootstrap.sh --tags host
