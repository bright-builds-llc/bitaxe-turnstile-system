import fixtures from "../conformance/bwg-worker-controller-0.4/fixtures.json";
import {
  parseWorkerLeaseGrant,
  parseWorkerLeaseRenewal,
  type WorkerLeaseGrant,
  type WorkerLeaseRenewal,
} from "./worker-controller";

type FixtureInputName = keyof typeof fixtures.inputs;

export function fixtureInput(name: FixtureInputName): WorkerLeaseGrant | WorkerLeaseRenewal {
  const definition = fixtures.inputs[name];
  const base = definition.base === "lease" ? fixtures.lease : fixtures.renewal;
  const value = { ...base, ...definition.overrides };
  return definition.base === "lease"
    ? parseWorkerLeaseGrant(value)
    : parseWorkerLeaseRenewal(value);
}

export function fixtureAuthorizationVerifier(
  input: WorkerLeaseGrant | WorkerLeaseRenewal,
  operation: "start" | "renew",
): boolean {
  if (operation === "renew") return canonical(input) === canonical(fixtureInput("renewal"));
  return [fixtureInput("lease"), fixtureInput("fresh_lease")]
    .some((expected) => canonical(input) === canonical(expected));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
