# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89

ARG FEDORA_VERSION=45@sha256:7791538bb091b82097f1aef71ec64b2154f886716f6f0b822dc839bb3c74c0aa
FROM ghcr.io/astral-sh/uv:0.12.0@sha256:606e70c71c852d03f611b1e56a195d08648507018a7057fab82c4974c4eae105 AS uv

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

RUN mkdir -p "${TMPDIR}" "${HOME}/.local/bin"

COPY --from=uv /uv /usr/local/bin/uv

WORKDIR /workspace/dotfiles

COPY --chown=${TEST_USER}:${TEST_USER} . .

USER root
RUN chown -R "${TEST_UID}:${TEST_GID}" "${TEST_HOME}" /workspace/dotfiles
USER ${TEST_USER}

RUN set -eu; \
    ansible-galaxy collection install -r ansible/requirements.yml -p .ansible/collections; \
    ansible-playbook --syntax-check ansible/site.yml; \
    ansible-playbook ansible/site.yml --tags repo-tools; \
    ansible-lint ansible; \
    yamllint .

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
