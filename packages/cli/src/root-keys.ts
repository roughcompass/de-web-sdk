/**
 * Root public keys that verify the enterprise trust policy package, as
 * base64 DER SubjectPublicKeyInfo. They're built into the CLI, so rotating
 * one needs an SDK release. The list is empty until the enterprise creates
 * its root keys; see design.md, Open Questions.
 */
export const ROOT_KEYS: string[] = [];
