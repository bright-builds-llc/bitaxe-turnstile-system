import { describe, expect, test } from "bun:test";

import {
  ConsentRequiredError,
  WorkCeilingExceededError,
  createHeadlessClient,
} from "./headless-client";
import {
  headlessInput,
  poolOffer,
  transportHarness,
  workers,
} from "./headless-client.test-support";

describe("Work Consent disclosure", () => {
  test("presents complete authenticated terms before Start", async () => {
    // Arrange
    const harness = transportHarness();
    const client = await createHeadlessClient(await headlessInput(harness.transport));

    // Act
    const disclosure = client.disclosure();

    // Assert
    expect(harness.calls).toEqual([]);
    expect(disclosure.expectedHashes).toBe("17592186044416");
    expect(disclosure.equivalentBinaryZeroWork).toBe(44);
    expect(disclosure.maybeDurationSeconds).toBeCloseTo(43.98046511104);
    expect(disclosure.maybeEnergyWattHours).toBeCloseTo(0.183251938);
    expect(disclosure.poolOfferSetSignature.split(".")).toHaveLength(3);
    expect(disclosure.authorityIssuer).toBe("https://authority.example");
    expect(disclosure.poolOffer).toEqual(poolOffer);
    expect(disclosure.rewardPolicy.networkValidResult).toBe("direct_coinbase_payout");
    expect(disclosure.payoutDestination).toBe("1BoatSLRHtKNngkdXEeobR76b53LETtpyT");
    expect(disclosure.workers).toEqual(workers);
  });

  test("binds consent to an immutable disclosure digest", async () => {
    // Arrange
    const harness = transportHarness();
    const input = await headlessInput(harness.transport);
    const client = await createHeadlessClient(input);

    // Act
    const mutableOffer = input.signedPoolOfferSet.offers[0];
    if (!mutableOffer) throw new Error("test Pool Offer is missing");
    mutableOffer.rewardPolicy.poolFeeBasisPoints = 500;
    const firstReceipt = await client.grantConsent();
    const disclosedAgain = client.disclosure();

    // Assert
    expect(firstReceipt.disclosureDigestSha256).toHaveLength(43);
    expect(firstReceipt.poolOfferSetSignature).toBe(disclosedAgain.poolOfferSetSignature);
    expect(disclosedAgain.rewardPolicy.poolFeeBasisPoints).toBe(0);
  });

  test("rejects a tampered Pool Offer signature", async () => {
    // Arrange
    const harness = transportHarness();
    const input = await headlessInput(harness.transport);
    const [header, payload, signature] = input.signedPoolOfferSet.signature.split(".");
    if (!header || !payload || !signature) throw new Error("test signature is malformed");
    const firstSignatureCharacter = signature.startsWith("A") ? "B" : "A";
    input.signedPoolOfferSet.signature =
      `${header}.${payload}.${firstSignatureCharacter}${signature.slice(1)}`;

    // Act
    const creation = createHeadlessClient(input);

    // Assert
    await expect(creation).rejects.toThrow("invalid Pool Offer signature");
  });

  test("rejects visible Pool Offer bytes that differ from signed claims", async () => {
    // Arrange
    const harness = transportHarness();
    const input = await headlessInput(harness.transport);
    const visibleOffer = input.signedPoolOfferSet.offers[0];
    if (!visibleOffer) throw new Error("test Pool Offer is missing");
    visibleOffer.miningPool.version = "v0.13";

    // Act
    const creation = createHeadlessClient(input);

    // Assert
    await expect(creation).rejects.toThrow("visible Pool Offers differ from signed claims");
  });

  test("rejects an empty Pool Offer set", async () => {
    // Arrange
    const harness = transportHarness();
    const input = await headlessInput(harness.transport);
    input.signedPoolOfferSet = { offers: [], signature: input.signedPoolOfferSet.signature };

    // Act
    const creation = createHeadlessClient(input);

    // Assert
    await expect(creation).rejects.toThrow("Pool Offer set must not be empty");
  });

  test("rejects duplicate Pool Offer identities", async () => {
    // Arrange
    const harness = transportHarness();
    const input = await headlessInput(harness.transport);
    const firstOffer = input.signedPoolOfferSet.offers[0];
    if (!firstOffer) throw new Error("test Pool Offer is missing");
    input.signedPoolOfferSet = {
      offers: [firstOffer, structuredClone(firstOffer)],
      signature: input.signedPoolOfferSet.signature,
    };

    // Act
    const creation = createHeadlessClient(input);

    // Assert
    await expect(creation).rejects.toThrow("Pool Offer identities must be unique");
  });

  test("rejects out-of-range Reward Policy basis points", async () => {
    // Arrange
    const harness = transportHarness();
    const input = await headlessInput(harness.transport);
    const firstOffer = input.signedPoolOfferSet.offers[0];
    if (!firstOffer) throw new Error("test Pool Offer is missing");
    firstOffer.rewardPolicy.poolFeeBasisPoints = -1;
    firstOffer.rewardPolicy.selectedDestinationBasisPoints = 10_001;

    // Act
    const creation = createHeadlessClient(input);

    // Assert
    await expect(creation).rejects.toThrow("Reward Policy is invalid");
  });

  test("rejects fractional Reward Policy basis points even when the sum is exact", async () => {
    // Arrange
    const harness = transportHarness();
    const input = await headlessInput(harness.transport);
    const firstOffer = input.signedPoolOfferSet.offers[0];
    if (!firstOffer) throw new Error("test Pool Offer is missing");
    firstOffer.rewardPolicy.selectedDestinationBasisPoints = 9_999.5;
    firstOffer.rewardPolicy.poolFeeBasisPoints = 0.5;

    // Act
    const creation = createHeadlessClient(input);

    // Assert
    await expect(creation).rejects.toThrow("Reward Policy is invalid");
  });

  test("rejects a checksum-invalid mainnet payout address", async () => {
    // Arrange
    const harness = transportHarness();
    const input = await headlessInput(harness.transport);
    input.selection = {
      poolOfferId: poolOffer.offerId,
      payoutDestinationType: "bitcoin_mainnet_address",
      bitcoinMainnetAddress: "1BoatSLRHtKNngkdXEeobR76b53LETtpy1",
    };

    // Act
    const creation = createHeadlessClient(input);

    // Assert
    await expect(creation).rejects.toThrow("selected Bitcoin mainnet address is invalid");
  });

  test("rejects an unapproved beneficiary", async () => {
    // Arrange
    const harness = transportHarness();
    const input = await headlessInput(harness.transport);
    input.selection = {
      poolOfferId: poolOffer.offerId,
      payoutDestinationType: "approved_beneficiary",
      beneficiaryId: "unapproved_beneficiary",
    };

    // Act
    const creation = createHeadlessClient(input);

    // Assert
    await expect(creation).rejects.toThrow("selected beneficiary is not approved");
  });

  test("discloses an offer-approved beneficiary selection", async () => {
    // Arrange
    const harness = transportHarness();
    const input = await headlessInput(harness.transport);
    input.selection = {
      poolOfferId: poolOffer.offerId,
      payoutDestinationType: "approved_beneficiary",
      beneficiaryId: "open_source_bitcoin_research",
    };
    const client = await createHeadlessClient(input);

    // Act
    const disclosure = client.disclosure();

    // Assert
    expect(disclosure.payoutDestinationType).toBe("approved_beneficiary");
    expect(disclosure.payoutDestination).toBe("open_source_bitcoin_research");
  });

  test("rejects a Pool Offer set from a different Authority issuer", async () => {
    // Arrange
    const harness = transportHarness();
    const input = await headlessInput(harness.transport);
    input.authorityTrust.issuer = "https://different-authority.example";

    // Act
    const creation = createHeadlessClient(input);

    // Assert
    await expect(creation).rejects.toThrow("signed Pool Offers do not match the Work Challenge");
  });

  test("rejects invalid Authority key metadata", async () => {
    // Arrange
    const harness = transportHarness();
    const input = await headlessInput(harness.transport);
    const authorityKey = input.authorityTrust.trustedKeys[0];
    if (!authorityKey) throw new Error("test Authority key is missing");
    Reflect.set(authorityKey, "use", "enc");

    // Act
    const creation = createHeadlessClient(input);

    // Assert
    await expect(creation).rejects.toThrow("invalid Pool Offer verification key");
  });

  test("rejects a malformed compact Pool Offer signature", async () => {
    // Arrange
    const harness = transportHarness();
    const input = await headlessInput(harness.transport);
    input.signedPoolOfferSet.signature = "not-a-compact-jws";

    // Act
    const creation = createHeadlessClient(input);

    // Assert
    await expect(creation).rejects.toThrow("Pool Offer signature is malformed");
  });

  test("rejects malformed Pool Offer URLs at the signed-data boundary", async () => {
    // Arrange
    const harness = transportHarness();
    const input = await headlessInput(harness.transport);
    const firstOffer = input.signedPoolOfferSet.offers[0];
    if (!firstOffer) throw new Error("test Pool Offer is missing");
    firstOffer.privacyTermsUrl = "https://";
    firstOffer.endpoint = "stratum+tcp://";

    // Act
    const creation = createHeadlessClient(input);

    // Assert
    await expect(creation).rejects.toThrow("Pool Offer is invalid");
  });

  test("rejects an unusable zero Stratum port", async () => {
    // Arrange
    const harness = transportHarness();
    const input = await headlessInput(harness.transport);
    const firstOffer = input.signedPoolOfferSet.offers[0];
    if (!firstOffer) throw new Error("test Pool Offer is missing");
    firstOffer.endpoint = "stratum+tcp://pool.example:0/";

    // Act
    const creation = createHeadlessClient(input);

    // Assert
    await expect(creation).rejects.toThrow("Pool Offer is invalid");
  });

  test("rejects duplicate approved beneficiary identities", async () => {
    // Arrange
    const harness = transportHarness();
    const input = await headlessInput(harness.transport);
    const firstOffer = input.signedPoolOfferSet.offers[0];
    const beneficiary = firstOffer?.payoutRequirements.approvedBeneficiaries[0];
    if (!firstOffer || !beneficiary) throw new Error("test beneficiary is missing");
    firstOffer.payoutRequirements.approvedBeneficiaries = [
      beneficiary,
      structuredClone(beneficiary),
    ];

    // Act
    const creation = createHeadlessClient(input);

    // Assert
    await expect(creation).rejects.toThrow("Pool Offer is invalid");
  });

  test("rejects empty approved beneficiary identity and terms", async () => {
    // Arrange
    const harness = transportHarness();
    const input = await headlessInput(harness.transport);
    const firstOffer = input.signedPoolOfferSet.offers[0];
    const beneficiary = firstOffer?.payoutRequirements.approvedBeneficiaries[0];
    if (!beneficiary) throw new Error("test beneficiary is missing");
    beneficiary.beneficiaryId = "";
    beneficiary.termsUrl = "https://";

    // Act
    const creation = createHeadlessClient(input);

    // Assert
    await expect(creation).rejects.toThrow("Pool Offer is invalid");
  });

  test("omits energy when a Worker does not disclose power", async () => {
    // Arrange
    const harness = transportHarness();
    const input = await headlessInput(harness.transport);
    input.workers = [{ workerId: "worker_unknown_power", displayName: "Worker", hashrateHs: "1" }];
    const client = await createHeadlessClient(input);

    // Act
    const disclosure = client.disclosure();

    // Assert
    expect(disclosure.maybeDurationSeconds).toBe(17_592_186_044_416);
    expect(disclosure.maybeEnergyWattHours).toBeUndefined();
  });

  test("does not start before explicit consent", async () => {
    // Arrange
    const harness = transportHarness();
    const client = await createHeadlessClient(await headlessInput(harness.transport));

    // Act
    const start = client.start();

    // Assert
    await expect(start).rejects.toBeInstanceOf(ConsentRequiredError);
    expect(harness.calls).toEqual([]);
  });

  test("enforces the Claimant work ceiling", async () => {
    // Arrange
    const harness = transportHarness();
    const client = await createHeadlessClient(
      await headlessInput(harness.transport, { maybeClaimantWorkCeiling: "8796093022208" }),
    );

    // Act
    const consent = client.grantConsent();

    // Assert
    await expect(consent).rejects.toBeInstanceOf(WorkCeilingExceededError);
  });

  test("enforces the independent client safety ceiling", async () => {
    // Arrange
    const harness = transportHarness();
    const client = await createHeadlessClient(
      await headlessInput(harness.transport, { maybeClientSafetyCeiling: "8796093022208" }),
    );

    // Act
    const consent = client.grantConsent();

    // Assert
    await expect(consent).rejects.toBeInstanceOf(WorkCeilingExceededError);
  });
});
