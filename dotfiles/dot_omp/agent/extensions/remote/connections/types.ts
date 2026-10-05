import type {
  SSHConnectionTarget,
  SSHHostInfo,
} from "@oh-my-pi/pi-coding-agent/ssh/connection-manager";
import type { HelperStatus } from "../helper/helper";

export interface Connection {
  id: string;
  target: SSHConnectionTarget;
  info: SSHHostInfo;
  home: string;
  cwd: string;
  controlPath: string;
  bash: string;
  zsh?: string | undefined;
  timeout?: string | undefined;
  arch: string;
  // Empty when native ssh:// cannot represent these connection settings
  fileRoot: string;
  helper?: HelperStatus | undefined;
}

export interface ConnectInput {
  target: string;
  id?: string | undefined;
  username?: string | undefined;
  port?: number | undefined;
  keyPath?: string | undefined;
  cwd?: string | undefined;
}

export interface ConnectionState {
  controlPath: string;
  active: boolean;
  masterPid?: number | undefined;
}
