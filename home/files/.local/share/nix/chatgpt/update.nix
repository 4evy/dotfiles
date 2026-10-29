{
  lib,
  chatgpt,
  coreutils,
  curl,
  gzip,
  libxml2,
  nix,
  writeShellApplication,
}:
let
  inherit (chatgpt) unwrapped updateScript;
in
writeShellApplication {
  name = "update-chatgpt";
  runtimeInputs = [
    coreutils
    curl
    gzip
    libxml2
    nix
  ];
  text = ''
    # Renovate has already selected a version, only its hash needs refreshing
    if [ "$#" = 1 ] && [ "$1" = "--version=skip" ]; then
      exec ${lib.escapeShellArgs updateScript}
    fi

    check_only=false
    case "$#" in
      0) ;;
      1)
        if [ "$1" != "--check" ]; then
          echo "usage: update-chatgpt [--check | --version=skip]" >&2
          exit 2
        fi
        check_only=true
        ;;
      *)
        echo "usage: update-chatgpt [--check | --version=skip]" >&2
        exit 2
        ;;
    esac

    repository_url="https://persistent.oaistatic.com/codex-app-prod/linux/rpm/x86_64"
    repomd="$(mktemp)"
    primary="$(mktemp)"
    trap 'rm -f "$repomd" "$primary"' EXIT

    curl -fsSL "$repository_url/repodata/repomd.xml" -o "$repomd"
    primary_path="$(xmllint --xpath \
      'string(//*[local-name()="data"][@type="primary"]/*[local-name()="location"]/@href)' \
      "$repomd")"
    curl -fsSL "$repository_url/$primary_path" | gzip -dc > "$primary"

    version="$(xmllint --xpath \
      'string(//*[local-name()="package"][*[local-name()="name"]="chatgpt"]/*[local-name()="version"]/@ver)' \
      "$primary")"
    location="$(xmllint --xpath \
      'string(//*[local-name()="package"][*[local-name()="name"]="chatgpt"]/*[local-name()="location"]/@href)' \
      "$primary")"
    checksum="$(xmllint --xpath \
      'string(//*[local-name()="package"][*[local-name()="name"]="chatgpt"]/*[local-name()="checksum"][@type="sha256"])' \
      "$primary")"

    if [ -z "$version" ] || [ -z "$location" ] || [ -z "$checksum" ]; then
      echo "The ChatGPT RPM metadata is incomplete" >&2
      exit 1
    fi

    hash="$(nix hash convert --hash-algo sha256 "$checksum")"
    url="$repository_url/$location"
    if [ "$url" != "$repository_url/chatgpt-$version-1.x86_64.rpm" ]; then
      echo "The ChatGPT RPM location no longer matches the package URL" >&2
      exit 1
    fi

    if [ "$version" = ${lib.escapeShellArg unwrapped.version} ] && \
      [ "$url" = ${lib.escapeShellArg unwrapped.src.url} ] && \
      [ "$hash" = ${lib.escapeShellArg unwrapped.src.outputHash} ]; then
      echo "ChatGPT is up to date at $version"
      exit 0
    fi

    if [ "$check_only" = true ]; then
      echo "ChatGPT $version is available; the package has ${unwrapped.version}" >&2
      exit 1
    fi

    # nix-update skips hashing an unchanged explicit version
    if [ "$version" = ${lib.escapeShellArg unwrapped.version} ]; then
      version=skip
    fi
    ${lib.escapeShellArgs updateScript} --version="$version"
  '';
}
