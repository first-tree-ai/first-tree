import { z } from "zod";
import { trustedInstallerUrlSchema } from "../url-policy.js";

export const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type Login = z.infer<typeof loginSchema>;

export const loginResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
});
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshToken = z.infer<typeof refreshTokenSchema>;

export const connectTokenExchangeSchema = z.object({
  token: z.string().min(1),
});
export type ConnectTokenExchange = z.infer<typeof connectTokenExchangeSchema>;

export const connectTokenResponseSchema = z.object({
  /**
   * Opaque short code accepted by `<binName> login <code>`.
   */
  token: z.string(),
  expiresIn: z.number(),
  /** `<binName> login <code>` — channel-aware bin name. */
  command: z.string(),
  /**
   * Authoritative bootstrap command shown by web onboarding and connection
   * dialogs. Prod/staging return independent public installer and explicit
   * `~/.local/bin/<binName> login <code>` lines without shell-level
   * transactional failure protection. Dev returns only the source-built CLI
   * login command.
   */
  bootstrapCommand: z.string(),
  /**
   * Public installer URL for prod/staging. Connect tokens never appear here;
   * the token is only in the local login command. `null` for dev.
   */
  installerUrl: trustedInstallerUrlSchema.nullable(),
  /**
   * Bin name the operator types after install. Channel-aware:
   *   - prod    → "first-tree"
   *   - staging → "first-tree-staging"
   *   - dev     → "first-tree-dev"
   * Web onboarding uses this to render the right `… login <code>` line
   * (and the right `… agent add` prefix in the new-agent-dialog).
   */
  binName: z.string(),
});
export type ConnectTokenResponse = z.infer<typeof connectTokenResponseSchema>;
