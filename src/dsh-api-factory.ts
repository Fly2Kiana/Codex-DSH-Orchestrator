import type { BridgeConfig } from "./config.js";
import { DshClient } from "./dsh-client.js";
import type { DshApi } from "./dsh-types.js";
import { GatewayConnection } from "./gateway-connection.js";
import { GatewayDshClient } from "./gateway-dsh-client.js";
import { createHostEndpointResolver } from "./host-endpoint.js";

/** Construction is inert. Only an explicitly selected Gateway may exchange a token. */
export function createDshApi(config: BridgeConfig, env: NodeJS.ProcessEnv = process.env): DshApi {
  const endpoint = createHostEndpointResolver(config);
  if (config.hostProtocol !== "gateway") return new DshClient(endpoint, config.requestTimeoutMs);
  const tokenEnv = config.connectTokenEnv ?? "DSH_CONNECT_TOKEN";
  return new GatewayDshClient(new GatewayConnection({ endpoint, timeoutMs: config.requestTimeoutMs,
    getConnectToken: () => env[tokenEnv] }), config.requestTimeoutMs);
}
