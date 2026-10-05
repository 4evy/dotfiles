import "@oh-my-pi/pi-coding-agent/discovery/ssh";

import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { posix, resolve } from "node:path";
import { loadCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { type SSHHost, sshCapability } from "@oh-my-pi/pi-coding-agent/capability/ssh";
import type { SSHConnectionTarget } from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import type { ConnectInput, Connection } from "./types";

export async function configuredHosts(
  cwd: string,
): Promise<{ hosts: SSHHost[]; warnings: string[] }> {
  // This is the native configured-host index, not ~/.ssh/config enumeration
  const result = await loadCapability<SSHHost>(sshCapability.id, { cwd });
  return { hosts: result.items, warnings: result.warnings };
}

export function identifier(value: string, label: string): string {
  if (!value || value.startsWith("-") || /[\s\p{Cc}]/u.test(value)) {
    throw new Error(
      `${label} must be nonempty, contain no whitespace/control characters, and not start with '-'`,
    );
  }
  return value;
}

function hostName(value: string): string {
  const host =
    value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  identifier(host, "SSH host");
  if (!isIP(host) && !/^[A-Za-z0-9._-]+$/u.test(host)) {
    throw new Error(
      "SSH host must be a hostname, OpenSSH alias, or IP address; specify ports with the port option",
    );
  }
  return host;
}

function userName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  identifier(value, "SSH username");
  if (/[/@:]/u.test(value))
    throw new Error("SSH username cannot contain '/', '@', or ':'");
  return value;
}

export function pathValue(value: string, label: string): string {
  if (!value || value.includes("\0"))
    throw new Error(`${label} must be nonempty and contain no NUL`);
  return value;
}

function identity(target: Omit<SSHConnectionTarget, "name">): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        target.host,
        target.username ?? null,
        target.port ?? null,
        target.keyPath ?? null,
        target.compat ?? false,
      ]),
    )
    .digest("hex");
}

export function fileRoot(
  target: SSHConnectionTarget,
  configured: SSHHost | undefined,
  hosts: SSHHost[],
): string {
  if (configured && identity(configured) === identity(target)) {
    return `ssh://${encodeURIComponent(configured.name)}/`;
  }
  // Native URIs have no key option and reject overrides of configured aliases
  if (target.keyPath || hosts.some((host) => host.name === target.host)) return "";
  const host = isIP(target.host) === 6 ? `[${target.host}]` : target.host;
  return `ssh://${target.username ? `${encodeURIComponent(target.username)}@` : ""}${
    host
  }${target.port === undefined ? "" : `:${target.port}`}/`;
}

export function resolveRemoteCwd(connection: Connection, cwd?: string): string {
  if (cwd === undefined) return connection.cwd;
  pathValue(cwd, "Remote cwd");
  if (cwd === "~") return connection.home;
  if (cwd.startsWith("~/")) return posix.resolve(connection.home, cwd.slice(2));
  if (cwd.startsWith("~"))
    throw new Error("Remote cwd supports '~/' but not another user's '~name' home");
  return posix.resolve(connection.cwd, cwd);
}

export function resolveTarget(input: ConnectInput, cwd: string, hosts: SSHHost[]) {
  const configured = hosts.find((host) => host.name === input.target);
  const destination = configured?.host ?? input.target;
  const parts = destination.split("@");
  const destinationHost = parts.at(-1);
  if (!destinationHost || parts.length > 2 || parts.some((part) => !part)) {
    throw new Error("SSH destination must be host or user@host");
  }
  const embeddedUser = parts.length === 2 ? userName(parts[0]) : undefined;
  const explicitUser = userName(input.username);
  const configuredUser = userName(configured?.username);
  if (embeddedUser && explicitUser && embeddedUser !== explicitUser) {
    throw new Error(
      "SSH username override conflicts with the destination's user@host username",
    );
  }
  if (
    embeddedUser &&
    configuredUser &&
    embeddedUser !== configuredUser &&
    explicitUser === undefined
  ) {
    throw new Error("Configured SSH username conflicts with its user@host destination");
  }
  const host = hostName(destinationHost);
  const username = explicitUser ?? embeddedUser ?? configuredUser;
  const port = input.port ?? configured?.port;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error("SSH port must be an integer between 1 and 65535");
  }
  const key = input.keyPath ?? configured?.keyPath;
  let keyPath: string | undefined;
  if (key !== undefined) {
    pathValue(key, "SSH key path");
    if (/\p{Cc}/u.test(key))
      throw new Error("SSH key path cannot contain control characters");
    if (key.startsWith("~") && key !== "~" && !key.startsWith("~/")) {
      throw new Error("SSH key path supports '~/' but not '~name'");
    }
    keyPath = resolve(
      cwd,
      key === "~"
        ? homedir()
        : key.startsWith("~/")
          ? resolve(homedir(), key.slice(2))
          : key,
    );
  }
  const facts = {
    host,
    ...(username === undefined ? {} : { username }),
    ...(port === undefined ? {} : { port }),
    ...(keyPath === undefined ? {} : { keyPath }),
    ...(configured?.compat === undefined ? {} : { compat: configured.compat }),
  };
  const digest = identity(facts);
  const target: SSHConnectionTarget = { name: `omp-remote-${digest}`, ...facts };
  const id =
    input.id === undefined ? target.name : identifier(input.id, "Connection id");
  return { target, digest, id, configured };
}
