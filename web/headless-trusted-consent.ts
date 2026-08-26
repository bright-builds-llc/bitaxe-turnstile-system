import type {
  AuthorityTrustInput,
  TrustedConsentRequest,
  TrustedConsentRequirement,
  WorkChallengeInput,
} from "./headless-client.types";
import { sha256Base64Url } from "./headless-values";

export async function prepareTrustedConsent(input: {
  challenge: WorkChallengeInput;
  authorityTrust: AuthorityTrustInput;
  poolOfferSetSignature: string;
  trustedConfirmationRequired: boolean;
  maybeNowUnixSeconds?: () => number;
}): Promise<{
  maybeRequirement: TrustedConsentRequirement | undefined;
  maybeRequest: TrustedConsentRequest | undefined;
  nowUnixSeconds: () => number;
}> {
  const nowUnixSeconds = input.maybeNowUnixSeconds ?? (() => Math.floor(Date.now() / 1_000));
  if (!input.trustedConfirmationRequired) {
    return { maybeRequirement: undefined, maybeRequest: undefined, nowUnixSeconds };
  }
  const digest = input.challenge.trustedConsentDisclosureDigestSha256;
  if (!digest?.match(/^[A-Za-z0-9_-]{43}$/u)) {
    throw new Error("trusted consent Authority disclosure digest is missing or invalid");
  }
  const maybeRequirement: TrustedConsentRequirement = {
    reason: input.challenge.actionPolicy === "account-creation.elevated.v1"
      ? "elevated_work"
      : "material_pool_terms",
    authorityOrigin: new URL(input.authorityTrust.issuer).origin,
  };
  return {
    maybeRequirement,
    maybeRequest: {
      ...maybeRequirement,
      challengeId: input.challenge.challengeId,
      disclosureDigestSha256: digest,
      poolOfferSetSignatureSha256: await sha256Base64Url(input.poolOfferSetSignature),
      expiresAtUnixSeconds: input.challenge.expiresAtUnixSeconds,
    },
    nowUnixSeconds,
  };
}
