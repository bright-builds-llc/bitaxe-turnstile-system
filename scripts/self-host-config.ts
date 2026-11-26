#!/usr/bin/env bun
/**
 * A self-hosted Gate deployment's one configuration file (`bwg-self-host/0.1`, bwg-core Ticket 24).
 * Each section holds one kind of value: the public origin, private links, the node, trust roots,
 * the paths of secrets (never their values), Pool Offers, Action Policies, payout terms and an
 * optional standard Worker. Unknown fields are refused, so a misspelling fails at startup.
 *
 * Usage: bun scripts/self-host-config.ts --config FILE
 * Prints `{ network, node, operatorAddress, launcherArguments }` for `scripts/self-host-gate.sh`.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

export const SELF_HOST_CONFIG_VERSION = "bwg-self-host/0.1";
const STANDARD_POLICY = "account-creation.standard.v1";
const MINIMUM_OVERRIDE = 1n << 43n;
const MAXIMUM_OVERRIDE = 1n << 45n;

export type ExternalNode = { kind: "external"; rpcUrl: string; zmqUrl: string; rpcCredentialsFile: string; datadir: string };

export type SelfHostConfig = {
  version: typeof SELF_HOST_CONFIG_VERSION;
  network: "regtest" | "mainnet";
  public: { origin: "tailscale" } | { origin: string; frontPort: number };
  private: { proxyAddress: string; proxyPort: number; runDirectory: string; postgresVolume: string };
  node: { kind: "managed" } | ExternalNode;
  trust: { ownerTrust: string; imageDirectory: string };
  secrets: { keysDirectory: string; leaseAuthorityDirectory: string };
  poolOffers: { engine: "hydra"; payout: "claimant_selected"; operatorAddress: string };
  actionPolicies: [typeof STANDARD_POLICY];
  payoutTerms: { expectedHashes?: string };
  standardWorker?: { displayName: string; hashrateHs: string };
};

class ConfigReader {
  constructor(private readonly repositoryRoot: string) {}

  fail(path: string, why: string): never {
    throw new Error(`self-host config: ${path} ${why}`);
  }

  record(value: unknown, path: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) this.fail(path || "the file", "must be an object");
    const record = value as Record<string, unknown>;
    const prefix = path ? `${path}.` : "";
    for (const key of Object.keys(record)) {
      if (!required.includes(key) && !optional.includes(key)) this.fail(`${prefix}${key}`, "is not a known field");
    }
    for (const key of required) if (!(key in record)) this.fail(`${prefix}${key}`, "is required");
    return record;
  }

  text(record: Record<string, unknown>, path: string, key: string, pattern: RegExp, why: string): string {
    const value = record[key];
    if (typeof value !== "string" || !pattern.test(value)) this.fail(`${path}.${key}`, why);
    return value;
  }

  port(record: Record<string, unknown>, path: string, key: string): number {
    const value = record[key];
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65535) this.fail(`${path}.${key}`, "must be a port number");
    return value as number;
  }

  exactly<T extends string>(record: Record<string, unknown>, path: string, key: string, expected: T): T {
    if (record[key] !== expected) this.fail(`${path}.${key}`, `must be ${expected}`);
    return expected;
  }

  /** An absolute path outside the repository, so no secret or deployment file can be committed. */
  path(record: Record<string, unknown>, path: string, key: string): string {
    const value = record[key];
    if (typeof value !== "string" || !isAbsolute(value)) this.fail(`${path}.${key}`, "must be an absolute path");
    const fromRepository = relative(this.repositoryRoot, resolve(value));
    if (!fromRepository.startsWith("..")) this.fail(`${path}.${key}`, "must be outside the repository");
    return value;
  }
}

export function parseSelfHostConfig(value: unknown, repositoryRoot: string): SelfHostConfig {
  // Annotated, so TypeScript treats `read.fail` as ending the path.
  const read: ConfigReader = new ConfigReader(repositoryRoot);
  const root = read.record(
    value,
    "",
    ["version", "network", "public", "private", "node", "trust", "secrets", "poolOffers", "actionPolicies", "payoutTerms"],
    ["standardWorker"],
  );
  if (root.version !== SELF_HOST_CONFIG_VERSION) read.fail("version", `must be ${SELF_HOST_CONFIG_VERSION}`);
  if (root.network !== "regtest" && root.network !== "mainnet") read.fail("network", "must be regtest or mainnet");
  const network = root.network;

  const publicSection = read.record(root.public, "public", ["origin"], ["frontPort"]);
  const origin = read.text(publicSection, "public", "origin", /^(tailscale|https:\/\/[A-Za-z0-9.-]+)$/u, "must be https://HOST or tailscale");
  if (origin !== "tailscale" && !("frontPort" in publicSection)) read.fail("public.frontPort", "is required");
  const publicConfig = origin === "tailscale" ? { origin } as const : { origin, frontPort: read.port(publicSection, "public", "frontPort") };

  const privateSection = read.record(root.private, "private", ["proxyAddress", "proxyPort", "runDirectory", "postgresVolume"]);
  const privateConfig = {
    proxyAddress: read.text(privateSection, "private", "proxyAddress", /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/u, "must be an IPv4 address"),
    proxyPort: read.port(privateSection, "private", "proxyPort"),
    runDirectory: read.path(privateSection, "private", "runDirectory"),
    postgresVolume: read.text(privateSection, "private", "postgresVolume", /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/u, "must be a Docker volume name"),
  };

  const nodeKind = read.record(root.node, "node", ["kind"], ["rpcUrl", "zmqUrl", "rpcCredentialsFile", "datadir"]).kind;
  let node: SelfHostConfig["node"];
  if (nodeKind === "managed") {
    if (network !== "regtest") read.fail("node.kind", "managed is for regtest only");
    read.record(root.node, "node", ["kind"]);
    node = { kind: "managed" };
  } else if (nodeKind === "external") {
    if (network !== "mainnet") read.fail("node.kind", "external is for mainnet only");
    const external = read.record(root.node, "node", ["kind", "rpcUrl", "zmqUrl", "rpcCredentialsFile", "datadir"]);
    node = {
      kind: "external",
      rpcUrl: read.text(external, "node", "rpcUrl", /^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/u, "must be http://127.0.0.1:PORT"),
      zmqUrl: read.text(external, "node", "zmqUrl", /^tcp:\/\/127\.0\.0\.1:[0-9]{1,5}$/u, "must be tcp://127.0.0.1:PORT"),
      rpcCredentialsFile: read.path(external, "node", "rpcCredentialsFile"),
      datadir: read.path(external, "node", "datadir"),
    };
  } else {
    read.fail("node.kind", "must be managed or external");
  }

  const trust = read.record(root.trust, "trust", ["ownerTrust", "imageDirectory"]);
  const secrets = read.record(root.secrets, "secrets", ["keysDirectory", "leaseAuthorityDirectory"]);
  const offers = read.record(root.poolOffers, "poolOffers", ["engine", "payout", "operatorAddress"]);
  if (JSON.stringify(root.actionPolicies) !== JSON.stringify([STANDARD_POLICY])) {
    read.fail("actionPolicies", `must be exactly [${STANDARD_POLICY}]`);
  }
  const terms = read.record(root.payoutTerms, "payoutTerms", [], ["expectedHashes"]);
  const payoutTerms: SelfHostConfig["payoutTerms"] = {};
  if ("expectedHashes" in terms) {
    const hashes = read.text(terms, "payoutTerms", "expectedHashes", /^[1-9][0-9]{0,19}$/u, "must be a whole number");
    if (BigInt(hashes) < MINIMUM_OVERRIDE || BigInt(hashes) > MAXIMUM_OVERRIDE) {
      read.fail("payoutTerms.expectedHashes", "must be between 2^43 and 2^45");
    }
    payoutTerms.expectedHashes = hashes;
  }

  const parsed: SelfHostConfig = {
    version: SELF_HOST_CONFIG_VERSION,
    network,
    public: publicConfig,
    private: privateConfig,
    node,
    trust: { ownerTrust: read.path(trust, "trust", "ownerTrust"), imageDirectory: read.path(trust, "trust", "imageDirectory") },
    secrets: {
      keysDirectory: read.path(secrets, "secrets", "keysDirectory"),
      leaseAuthorityDirectory: read.path(secrets, "secrets", "leaseAuthorityDirectory"),
    },
    poolOffers: {
      engine: read.exactly(offers, "poolOffers", "engine", "hydra"),
      payout: read.exactly(offers, "poolOffers", "payout", "claimant_selected"),
      operatorAddress: read.text(offers, "poolOffers", "operatorAddress", /^[A-Za-z0-9]{14,90}$/u, "must be a Bitcoin address"),
    },
    actionPolicies: [STANDARD_POLICY],
    payoutTerms,
  };
  if (root.standardWorker !== undefined) {
    const worker = read.record(root.standardWorker, "standardWorker", ["displayName", "hashrateHs"]);
    parsed.standardWorker = {
      displayName: read.text(worker, "standardWorker", "displayName", /^[^\u0000-\u001f]{1,64}$/u, "must be 1 to 64 characters"),
      hashrateHs: read.text(worker, "standardWorker", "hashrateHs", /^[1-9][0-9]{0,19}$/u, "must be a whole number"),
    };
  }
  return parsed;
}

/** The launcher's flags for this configuration; the wrapper adds `--upstream` once Hydra listens. */
export function launcherArguments(config: SelfHostConfig): string[] {
  const args = [
    "--keys-dir", config.secrets.keysDirectory,
    "--lease-authority-dir", config.secrets.leaseAuthorityDirectory,
    "--owner-trust", config.trust.ownerTrust,
    "--image-dir", config.trust.imageDirectory,
    "--run-dir", config.private.runDirectory,
    "--proxy-address", config.private.proxyAddress,
    "--proxy-port", String(config.private.proxyPort),
    "--postgres-volume", config.private.postgresVolume,
    "--readiness-address", config.poolOffers.operatorAddress,
    "--network", config.network,
  ];
  if ("frontPort" in config.public) {
    args.push("--loopback-origin", config.public.origin, "--front-port", String(config.public.frontPort));
  }
  if (config.payoutTerms.expectedHashes) args.push("--expected-hashes", config.payoutTerms.expectedHashes);
  if (config.standardWorker) {
    args.push("--standard-worker-name", config.standardWorker.displayName, "--standard-worker-hashrate", config.standardWorker.hashrateHs);
  }
  return args;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { config: { type: "string" } } });
  if (!values.config) throw new Error("usage: self-host-config --config FILE");
  let config: SelfHostConfig;
  try {
    config = parseSelfHostConfig(JSON.parse(readFileSync(values.config, "utf8")), resolve(import.meta.dir, ".."));
  } catch (error) {
    // The message names the field; a stack trace would only bury it.
    process.stderr.write(`Refusing to self-host: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
  const node = config.node;
  process.stdout.write(`${JSON.stringify({
    network: config.network,
    node,
    operatorAddress: config.poolOffers.operatorAddress,
    launcherArguments: launcherArguments(config),
  })}\n`);
}
