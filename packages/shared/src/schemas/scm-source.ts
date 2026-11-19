import { z } from "zod";

export const SCM_PROVIDERS = ["github", "gitlab"] as const;
export const scmProviderSchema = z.enum(SCM_PROVIDERS);
export type ScmProvider = z.infer<typeof scmProviderSchema>;

/**
 * Authority established by the ingress adapter. This value is derived from
 * the verified endpoint/credential and must never be copied from webhook
 * headers or payload fields.
 *
 * `server_observed` marks an event the server reconstructed itself by polling
 * the provider's REST API (no inbound delivery, no signature). It is
 * deliberately distinct from the two delivery-based authorities: a polled
 * event is exactly as trustworthy as the credential that read it, and
 * downstream code that reasons about "how do we know this happened" must be
 * able to tell the two apart.
 */
export const SCM_INGRESS_AUTHORITIES = ["verified_signature", "url_bearer", "server_observed"] as const;
export const scmIngressAuthoritySchema = z.enum(SCM_INGRESS_AUTHORITIES);
export type ScmIngressAuthority = z.infer<typeof scmIngressAuthoritySchema>;

/**
 * Provider-neutral identity of the ingress source. `externalId` is opaque to
 * the shared processing kernel; provider adapters and their own stores decide
 * what it represents (for example, a GitHub App installation).
 */
export const scmSourceSchema = z.object({
  organizationId: z.string().min(1),
  externalId: z.string().min(1),
});
export type ScmSource = z.infer<typeof scmSourceSchema>;

export const scmIngressContextSchema = z.object({
  provider: scmProviderSchema,
  source: scmSourceSchema,
  stableDeliveryId: z.string().min(1).nullable(),
  ingressAuthority: scmIngressAuthoritySchema,
});
export type ScmIngressContext = z.infer<typeof scmIngressContextSchema>;
