# syntax=docker/dockerfile:1

ARG FEDORA_VERSION=44
FROM registry.fedoraproject.org/fedora:${FEDORA_VERSION} AS dotfiles-test

ARG TARGETPLATFORM
ARG TEST_USER=dotfiles
ARG TEST_UID=1000
ARG TEST_GID=${TEST_UID}
ARG TEST_HOME=/home/dotfiles

COPY containers/fedora-smoke-test-packages.txt /tmp/fedora-smoke-test-packages.txt
RUN --mount=type=cache,id=dotfiles-dnf4-${TARGETPLATFORM},sharing=locked,target=/var/cache/dnf \
    --mount=type=cache,id=dotfiles-dnf5-${TARGETPLATFORM},sharing=locked,target=/var/cache/libdnf5 \
    <<EOF
set -eu

dnf install -y --setopt=install_weak_deps=False $(sed '/^[[:space:]]*#/d; /^[[:space:]]*$/d' /tmp/fedora-smoke-test-packages.txt)
EOF

RUN <<EOF
set -eu

mkdir -p "$(dirname "${TEST_HOME}")"
groupadd --gid "${TEST_GID}" "${TEST_USER}"
useradd --uid "${TEST_UID}" --gid "${TEST_GID}" --create-home --home-dir "${TEST_HOME}" "${TEST_USER}"

chown -R "${TEST_UID}:${TEST_GID}" "${TEST_HOME}"
EOF

USER ${TEST_USER}
ENV HOME=${TEST_HOME}
ENV XDG_CACHE_HOME=${TEST_HOME}/.cache
ENV TMPDIR=${TEST_HOME}/.cache/tmp
ENV TMP=${TEST_HOME}/.cache/tmp
ENV TEMP=${TEST_HOME}/.cache/tmp
ENV PATH=${TEST_HOME}/.local/bin:${TEST_HOME}/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV DOTFILES_PROCESS_CAPTURE_TIMEOUT_SECS=180
ENV GOTOOLCHAIN=auto
ENV GOCACHE=${TEST_HOME}/.cache/go-build
ENV GOMODCACHE=${TEST_HOME}/go/pkg/mod

RUN mkdir -p "${TMPDIR}" "${GOCACHE}" "${GOMODCACHE}" "${HOME}/.local/bin"

WORKDIR /workspace/dotfiles

COPY --chown=${TEST_USER}:${TEST_USER} go.mod go.sum ./
RUN --mount=type=cache,id=dotfiles-go-mod-${TARGETPLATFORM},target=/home/dotfiles/go/pkg/mod,uid=${TEST_UID},gid=${TEST_GID} \
    go mod download

COPY --chown=${TEST_USER}:${TEST_USER} . .

USER root
RUN chown -R "${TEST_UID}:${TEST_GID}" "${TEST_HOME}" /workspace/dotfiles
USER ${TEST_USER}

RUN --mount=type=cache,id=dotfiles-go-mod-${TARGETPLATFORM},target=/home/dotfiles/go/pkg/mod,uid=${TEST_UID},gid=${TEST_GID} \
    --mount=type=cache,id=dotfiles-go-build-${TARGETPLATFORM},target=/home/dotfiles/.cache/go-build,uid=${TEST_UID},gid=${TEST_GID} \
    <<EOF
set -eu

ansible-galaxy collection install -r ansible/requirements.yml -p .ansible/collections
ansible-playbook --syntax-check ansible/playbooks/site.yml
ansible-playbook ansible/playbooks/site.yml --tags local
ansible-lint --version >/dev/null
yamllint --version >/dev/null
EOF

USER root
RUN chown -R "${TEST_UID}:${TEST_GID}" "${TEST_HOME}" /workspace/dotfiles
USER ${TEST_USER}

RUN <<EOF
set -eu

chezmoi_targets="
  .zshrc
  .bashrc
  .gitconfig
  .gitignore_global
  .ssh/config
  .ssh/allowed_signers
  .codex
  .cache/starship
  .cache/zellij
  .config
  .local/bin
  .local/share/applications
  .local/share/zellij
"

set --
for target in ${chezmoi_targets}; do
  set -- "$@" "${HOME}/${target}"
done

chezmoi \
  --source=/workspace/dotfiles/dotfiles \
  --destination="${HOME}" \
  apply \
  --force \
  --no-tty \
  --parent-dirs \
  --exclude=scripts \
  "$@"
EOF

RUN ansible-playbook --version >/dev/null
RUN ansible-lint --version >/dev/null
RUN yamllint --version >/dev/null
