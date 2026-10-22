import type { BridgeConfig } from "./config.js";
import { discoverRunningWindowsDesktopHost, discoverRunningOfficialDesktopHost } from "./desktop-host-discovery.js";
import type { HostEndpointResolver } from "./dsh-client.js";

type DesktopDiscover = typeof discoverRunningWindowsDesktopHost;

export function createHostEndpointResolver(
  config: BridgeConfig,
  discoverDesktop: DesktopDiscover = discoverRunningWindowsDesktopHost,
  discoverOfficialDesktop: typeof discoverRunningOfficialDesktopHost = discoverRunningOfficialDesktopHost,
): HostEndpointResolver {
  if (config.hostMode === "desktop-auto") {
    return {
      mode: "desktop-auto",
      resolve: async () => {
        const resolution = config.hostProtocol === "gateway"
          ? await discoverOfficialDesktop() : await discoverDesktop(Math.min(config.requestTimeoutMs, 5_000));
        return { baseUrl: resolution.baseUrl, source: resolution.source };
      },
    };
  }
  const baseUrl = config.hostUrl.replace(/\/$/, "");
  return {
    mode: "static",
    configuredBaseUrl: baseUrl,
    resolve: async () => ({ baseUrl, source: "configured" }),
  };
}

export function configuredHostLabel(config: BridgeConfig): string {
  return config.hostMode === "desktop-auto"
    ? config.hostProtocol === "gateway" ? "official DeepSeek Harness (automatic loopback candidate discovery)"
      : "DSH Desktop (automatic loopback discovery)" : config.hostUrl;
}
