import { FirstTreeHubSDK } from "@first-tree/client";
import { fail } from "../../cli/output.js";
import { accessTokenForOrigin } from "../../core/access-token.js";
import { resolveServerUrl } from "../../core/bootstrap.js";
import { CLI_USER_AGENT } from "../../core/version.js";

/** Build an SDK that speaks only as the currently signed-in human member. */
export function createMemberSdk(): FirstTreeHubSDK {
  let serverUrl: string;
  try {
    serverUrl = resolveServerUrl(process.env.FIRST_TREE_SERVER_URL);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail("MISSING_SERVER_URL", message, 2);
  }
  return new FirstTreeHubSDK({
    serverUrl,
    getAccessToken: (options) => accessTokenForOrigin(serverUrl, options),
    userAgent: CLI_USER_AGENT,
  });
}
