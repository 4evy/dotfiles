# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89

ARG FEDORA_VERSION=45@sha256:799a9705651afc589d2336f02eaf570efe0a5309cdb65a8fc88416906017009a
FROM ghcr.io/astral-sh/uv:0.11.31@sha256:ecd4de2f060c64bea0ff8ecb182ddf46ba3fcccdc8a60cfdbaf20d1a047d7437 AS uv

FROM registry.fedoraproject.org/fedora:${FEDORA_VERSION} AS dotfiles-test

ARG TARGETPLATFORM
ARG TEST_USER=dotfiles
ARG TEST_UID=1000
ARG TEST_GID=${TEST_UID}
ARG TEST_HOME=/home/dotfiles

# Keep this smoke-test Dockerfile on Podman/Buildah-compatible syntax. GitHub
# Actions installs Podman from Ubuntu apt, whose imagebuilder rejects BuildKit
# conveniences like COPY --link and heredoc RUN blocks.
COPY containers/fedora-smoke-test-packages.txt /tmp/fedora-smoke-test-packages.txt
# hadolint ignore=DL3041
RUN --mount=type=cache,id=dotfiles-dnf4-${TARGETPLATFORM},sharing=locked,target=/var/cache/dnf \
    --mount=type=cache,id=dotfiles-dnf5-${TARGETPLATFORM},sharing=locked,target=/var/cache/libdnf5 \
    set -eu; \
    sed '/^[[:space:]]*#/d; /^[[:space:]]*$/d' /tmp/fedora-smoke-test-packages.txt \
      > /tmp/fedora-smoke-test-packages.filtered.txt; \
    xargs -r dnf install -y --setopt=install_weak_deps=False \
      < /tmp/fedora-smoke-test-packages.filtered.txt

RUN set -eu; \
    mkdir -p "$(dirname "${TEST_HOME}")"; \
    groupadd --gid "${TEST_GID}" "${TEST_USER}"; \
    useradd --uid "${TEST_UID}" --gid "${TEST_GID}" --create-home --home-dir "${TEST_HOME}" "${TEST_USER}"; \
    chown -R "${TEST_UID}:${TEST_GID}" "${TEST_HOME}"

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

COPY --from=uv /uv /usr/local/bin/uv

WORKDIR /workspace/dotfiles

COPY --chown=${TEST_USER}:${TEST_USER} go.mod go.sum ./
RUN --mount=type=cache,id=dotfiles-go-mod-${TARGETPLATFORM},target=/home/dotfiles/go/pkg/mod,uid=${TEST_UID},gid=${TEST_GID} \
    go mod download

COPY --chown=${TEST_USER}:${TEST_USER} . .

USER root
RUN chown -R "${TEST_UID}:${TEST_GID}" "${TEST_HOME}" /workspace/dotfiles
USER ${TEST_USER}

# ansible-test discovers its collection from the working directory.
# hadolint ignore=DL3003
RUN --mount=type=cache,id=dotfiles-go-mod-${TARGETPLATFORM},target=/home/dotfiles/go/pkg/mod,uid=${TEST_UID},gid=${TEST_GID} \
    --mount=type=cache,id=dotfiles-go-build-${TARGETPLATFORM},target=/home/dotfiles/.cache/go-build,uid=${TEST_UID},gid=${TEST_GID} \
    set -eu; \
    ansible-galaxy collection install -r ansible/requirements.yml -p .ansible/collections; \
    for playbook in ansible/playbooks/bootstrap.yml ansible/playbooks/userland.yml ansible/playbooks/host.yml ansible/playbooks/site.yml; do \
      ansible-playbook --syntax-check "${playbook}"; \
    done; \
    ansible-playbook ansible/playbooks/site.yml --tags local; \
    ansible-lint ansible; \
    yamllint .; \
    cd ansible/collections/ansible_collections/evy/dotfiles; \
    PYTHONWARNINGS=ignore::DeprecationWarning \
      uv tool run --from pycodestyle pycodestyle \
        --max-line-length 160 \
        --config /dev/null \
        --ignore E203,E402,E701,E704,E741,W503,W504 \
        plugins/modules/operation.py; \
    ansible-test sanity --local --skip-test pep8 --skip-test validate-modules; \
    ansible-test integration --local operation

USER root
RUN chown -R "${TEST_UID}:${TEST_GID}" "${TEST_HOME}" /workspace/dotfiles
USER ${TEST_USER}

RUN set -eu; \
    chezmoi_targets=" \
      .zshrc \
      .bashrc \
      .gitconfig \
      .gitignore_global \
      .ssh/config \
      .ssh/allowed_signers \
      .codex \
      .cache/starship \
      .config \
      .local/share/applications \
    "; \
    set --; \
    for target in ${chezmoi_targets}; do \
      set -- "$@" "${HOME}/${target}"; \
    done; \
    chezmoi \
      --source=/workspace/dotfiles/dotfiles \
      --destination="${HOME}" \
      apply \
      --force \
      --no-tty \
      --parent-dirs \
      --exclude=scripts \
      "$@"

RUN ansible-playbook --version >/dev/null \
    && ansible-lint --version >/dev/null \
    && yamllint --version >/dev/null
