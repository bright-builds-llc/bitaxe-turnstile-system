import { expect, test } from "bun:test";

import { launcherArguments, parseSelfHostConfig } from "./self-host-config";

const REPOSITORY = "/repos/turnstile";

function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "bwg-self-host/0.1",
    network: "mainnet",
    public: { origin: "https://gate.example.org", frontPort: 8443 },
    private: { proxyAddress: "192.0.2.10", proxyPort: 3334, runDirectory: "/srv/bwg/run", postgresVolume: "bwg-gate" },
    node: {
      kind: "external",
      rpcUrl: "http://127.0.0.1:8332",
      zmqUrl: "tcp://127.0.0.1:28332",
      rpcCredentialsFile: "/srv/bwg/node-credentials",
      datadir: "/srv/bwg/hydra",
    },
    trust: { ownerTrust: "/srv/bwg/trust.json", imageDirectory: "/srv/bwg/image" },
    secrets: { keysDirectory: "/srv/bwg/keys", leaseAuthorityDirectory: "/srv/bwg/lease" },
    poolOffers: { engine: "hydra", payout: "claimant_selected", operatorAddress: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT" },
    actionPolicies: ["account-creation.standard.v1"],
    payoutTerms: {},
    ...overrides,
  };
}

const parse = (value: unknown) => parseSelfHostConfig(value, REPOSITORY);

test("reads a complete mainnet configuration", () => {
  // Act
  const parsed = parse(config());

  // Assert
  expect(parsed.network).toBe("mainnet");
});

test("refuses an unknown section, so a misspelling fails at startup", () => {
  // Act and assert
  expect(() => parse(config({ secret: {} }))).toThrow("self-host config: secret is not a known field");
});

test("refuses a secret value where only its file's path belongs", () => {
  // Act and assert
  expect(() =>
    parse(config({ secrets: { keysDirectory: "/srv/bwg/keys", leaseAuthorityDirectory: "/srv/bwg/lease", seed: "00" } })),
  ).toThrow("self-host config: secrets.seed is not a known field");
});

test("refuses a secrets directory inside the repository", () => {
  // Act and assert
  expect(() =>
    parse(config({ secrets: { keysDirectory: `${REPOSITORY}/keys`, leaseAuthorityDirectory: "/srv/bwg/lease" } })),
  ).toThrow("self-host config: secrets.keysDirectory must be outside the repository");
});

test("refuses a relative path", () => {
  // Act and assert
  expect(() => parse(config({ trust: { ownerTrust: "trust.json", imageDirectory: "/srv/bwg/image" } }))).toThrow(
    "self-host config: trust.ownerTrust must be an absolute path",
  );
});

test("refuses a public origin that isn't HTTPS", () => {
  // Act and assert
  expect(() => parse(config({ public: { origin: "http://gate.example.org", frontPort: 8443 } }))).toThrow(
    "self-host config: public.origin must be https://HOST or tailscale",
  );
});

test("needs the front's port when the self-hoster's proxy terminates TLS", () => {
  // Act and assert
  expect(() => parse(config({ public: { origin: "https://gate.example.org" } }))).toThrow(
    "self-host config: public.frontPort is required",
  );
});

test("refuses a node the stack would manage on mainnet", () => {
  // Act and assert
  expect(() => parse(config({ node: { kind: "managed" } }))).toThrow(
    "self-host config: node.kind managed is for regtest only",
  );
});

test("refuses a node RPC URL off loopback", () => {
  // Act and assert
  expect(() =>
    parse(config({ node: { ...(config().node as object), rpcUrl: "http://192.0.2.20:8332" } })),
  ).toThrow("self-host config: node.rpcUrl must be http://127.0.0.1:PORT");
});

test("refuses an Action Policy the reference doesn't implement", () => {
  // Act and assert
  expect(() => parse(config({ actionPolicies: ["account-creation.elevated.v1"] }))).toThrow(
    "self-host config: actionPolicies must be exactly [account-creation.standard.v1]",
  );
});

test("refuses a payout model other than the claimant's choice", () => {
  // Act and assert
  expect(() =>
    parse(config({ poolOffers: { engine: "hydra", payout: "operator", operatorAddress: "1BoatSLRHtKNngkdXEeobR76b53LETtpyT" } })),
  ).toThrow("self-host config: poolOffers.payout must be claimant_selected");
});

test("refuses a Work Requirement outside the Standard policy's bounds", () => {
  // Act and assert
  expect(() => parse(config({ payoutTerms: { expectedHashes: "1000" } }))).toThrow(
    "self-host config: payoutTerms.expectedHashes must be between 2^43 and 2^45",
  );
});

test("passes paths, the public origin and the private links to the launcher", () => {
  // Act
  const args = launcherArguments(parse(config()));

  // Assert
  expect(args).toEqual([
    "--keys-dir", "/srv/bwg/keys",
    "--lease-authority-dir", "/srv/bwg/lease",
    "--owner-trust", "/srv/bwg/trust.json",
    "--image-dir", "/srv/bwg/image",
    "--run-dir", "/srv/bwg/run",
    "--proxy-address", "192.0.2.10",
    "--proxy-port", "3334",
    "--postgres-volume", "bwg-gate",
    "--readiness-address", "1BoatSLRHtKNngkdXEeobR76b53LETtpyT",
    "--network", "mainnet",
    "--loopback-origin", "https://gate.example.org",
    "--front-port", "8443",
  ]);
});

test("leaves the origin to Tailscale when the configuration says so", () => {
  // Act
  const args = launcherArguments(parse(config({ public: { origin: "tailscale" } })));

  // Assert
  expect(args).not.toContain("--loopback-origin");
});

test("passes the Work Requirement and the standard Worker when configured", () => {
  // Arrange
  const parsed = parse(config({
    payoutTerms: { expectedHashes: "8796093022208" },
    standardWorker: { displayName: "Your Stratum V1 Worker", hashrateHs: "1000000000000" },
  }));

  // Act
  const args = launcherArguments(parsed);

  // Assert
  expect(args.slice(-6)).toEqual([
    "--expected-hashes", "8796093022208",
    "--standard-worker-name", "Your Stratum V1 Worker",
    "--standard-worker-hashrate", "1000000000000",
  ]);
});

test("reads a regtest configuration whose stack manages its node", () => {
  // Act
  const parsed = parse(config({ network: "regtest", node: { kind: "managed" } }));

  // Assert
  expect(parsed.node).toEqual({ kind: "managed" });
});
