// The builder lives in `@first-tree/shared` so every surface (Web, and any
// future client) constructs Context Tree source links through one contract;
// this module stays as the stable import path for existing Web callers.
export { type ContextTreeSourceRef, contextTreeSourceHref } from "@first-tree/shared";
