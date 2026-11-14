import { curlInstallerProtocolFlags } from "@first-tree/shared";
import type { ChannelConfig } from "@first-tree/shared/channel";
import { channelConfig } from "./channel.js";

/**
 * Return the supported installation command for this CLI's release channel.
 * Hosted channels install the bundled portable runtime; the unpublished dev
 * channel continues to install from the current source checkout.
 */
export function getChannelInstallCommand(config: ChannelConfig = channelConfig): string {
  if (config.channel === "dev") return "./scripts/dev-install.sh";

  const baseUrl = config.portable.downloadBaseUrl?.replace(/\/+$/, "");
  const installerPath = config.portable.publicInstallerPath?.replace(/^\/+/, "");
  if (!baseUrl || !installerPath) {
    throw new Error(`Portable installer is not configured for the ${config.channel} channel`);
  }

  const installerUrl = `${baseUrl}/${installerPath}`;
  return `curl -fsSL ${curlInstallerProtocolFlags(installerUrl)} ${installerUrl} | sh`;
}
