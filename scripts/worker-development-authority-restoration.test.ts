import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkerDeploymentTrust } from "../web/worker-deployment-trust";
import { verifyWorkerLeaseAuthorization, type WorkerLeaseAuthorizationInput } from "../web/worker-lease-authorization";
import { parseRestorationReplayArtifact, parseRestorationWindow } from "../web/worker-restoration-qualification";

const challengeId = "challenge_restoration_scope_01";
const binding = "S".repeat(43);
const start = (leaseId: string, durationMilliseconds: number, renewAfterMilliseconds: number): WorkerLeaseAuthorizationInput => ({
  operation: "start", activeChallengeId: challengeId, controlSessionBindingSha256: binding,
  request: { protocolVersion: "bwg-worker-controller/0.4", leaseId, challengeId, durationMilliseconds, renewAfterMilliseconds,
    stratum: { endpoint: "stratum+tcp://127.0.0.1:3333/", username: "fixture-session-user", password: "fixture-session-password" } },
});
const renew: WorkerLeaseAuthorizationInput = { operation: "renew", activeChallengeId: challengeId, controlSessionBindingSha256: binding,
  request: { protocolVersion: "bwg-worker-controller/0.4", leaseId: "lease_restoration_60", durationMilliseconds: 60000, renewAfterMilliseconds: 20000 } };

async function authority(args: readonly string[], maybeInput?: WorkerLeaseAuthorizationInput) {
  const child = Bun.spawn(["bun", "scripts/worker-development-authority.ts", ...args], { cwd: import.meta.dir + "/..",
    ...(maybeInput ? { stdin: new TextEncoder().encode(JSON.stringify(maybeInput)) } : {}), stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exitCode, stdout, stderr };
}

test("the development authority signs unbudgeted restoration Starts, an expiry Start and one renewal", async () => {
  // Arrange
  const parent = await mkdtemp(join(tmpdir(), "bwg-worker-authority-restoration-test-"));
  const directory = join(parent, "authority");
  try {
    expect((await authority(["init", "--directory", directory])).exitCode).toBe(0);
    const inputs = [start("lease_restoration_60", 60000, 20000), renew, start("lease_restoration_30", 30000, 10000)];
    // Act
    const signed = [];
    for (const input of inputs) signed.push(await authority([`sign-${input.operation}`, "--directory", directory, "--input", "-", "--output", "-"], input));
    // Assert
    const trust = parseWorkerDeploymentTrust(JSON.parse(await readFile(join(directory, "trust.json"), "utf8")));
    for (const [index, result] of signed.entries()) {
      const input = inputs[index];
      if (!input) throw new Error("fixture_input");
      expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: "" });
      const artifact = JSON.parse(result.stdout);
      await expect(verifyWorkerLeaseAuthorization(artifact.authorization, input, trust.workLeaseAuthority)).resolves.toMatchObject({ sequence: BigInt(index + 1) });
      if (input.operation === "renew") expect(parseRestorationReplayArtifact({ operation: "renew", renewal: { ...input.request, authorization: artifact.authorization } }).operation).toBe("renew");
      else expect(parseRestorationWindow({ grant: { ...input.request, authorization: artifact.authorization }, renewals: [] }).grant.leaseId).toBe(input.request.leaseId);
    }
  } finally {
    await rm(parent, { recursive: true });
  }
});
