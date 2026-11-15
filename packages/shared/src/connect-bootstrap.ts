import { curlInstallerProtocolFlags } from "./url-policy.js";

const SAFE_SHELL_ARG_PATTERN = /^[A-Za-z0-9_@%+=:,./-]+$/;

export const CONNECT_BOOTSTRAP_CODE_PLACEHOLDER = "FIRST_TREE_CONNECT_CODE_PLACEHOLDER";

export type ConnectBootstrapCommandTemplate = {
  command: string;
  codePlaceholder: typeof CONNECT_BOOTSTRAP_CODE_PLACEHOLDER;
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function shellArg(value: string): string {
  return SAFE_SHELL_ARG_PATTERN.test(value) ? value : shellQuote(value);
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}

function normalizeDownloadBaseUrl(value: string): string {
  return stripTrailingSlashes(value);
}

function normalizeCommandServerUrl(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return stripTrailingSlashes(value);
  }
}

export function buildLoginCommand(options: {
  executable: string;
  tokenArg: string;
  serverUrl: string;
  defaultServerUrl: string;
}): string {
  const serverUrl = normalizeCommandServerUrl(options.serverUrl);
  const prefix = serverUrl === options.defaultServerUrl ? "" : `FIRST_TREE_SERVER_URL=${shellQuote(serverUrl)} `;
  return `${prefix}${options.executable} login ${shellArg(options.tokenArg)}`;
}

export function portableCliExecutable(binName: string): string {
  return `~/.local/bin/${binName}`;
}

export function buildPortableBootstrapCommand(options: {
  installerUrl: string;
  portableDownloadBaseUrl: string;
  defaultPortableDownloadBaseUrl: string;
  binName: string;
  token: string;
  serverUrl: string;
  defaultServerUrl: string;
}): string {
  const isCustomDownloadBase =
    normalizeDownloadBaseUrl(options.portableDownloadBaseUrl) !==
    normalizeDownloadBaseUrl(options.defaultPortableDownloadBaseUrl);
  const installerUrl = isCustomDownloadBase ? shellQuote(options.installerUrl) : options.installerUrl;
  const installerEnv = isCustomDownloadBase
    ? `FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL=${shellQuote(options.portableDownloadBaseUrl)} `
    : "";
  const loginCommand = buildLoginCommand({
    executable: portableCliExecutable(options.binName),
    tokenArg: options.token,
    serverUrl: options.serverUrl,
    defaultServerUrl: options.defaultServerUrl,
  });

  return [
    `curl -fsSL ${curlInstallerProtocolFlags(options.installerUrl)} ${installerUrl} | ${installerEnv}sh`,
    loginCommand,
  ].join("\n");
}

export function materializeConnectBootstrapCommand(template: ConnectBootstrapCommandTemplate, code: string): string {
  if (!SAFE_SHELL_ARG_PATTERN.test(code)) {
    throw new TypeError("A shell-safe connect code is required");
  }
  const parts = template.command.split(template.codePlaceholder);
  if (parts.length !== 2) {
    throw new TypeError("The connect bootstrap template must contain its code placeholder exactly once");
  }
  return `${parts[0]}${code}${parts[1]}`;
}
