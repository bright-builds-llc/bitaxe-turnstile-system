import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import startInputFixture from "../conformance/bwg-worker-deployment-trust-0.2/start-input.json";
import { parseWorkerDeploymentTrust } from "../web/worker-deployment-trust";
import {
  verifyWorkerLeaseAuthorization,
  type WorkerLeaseAuthorizationInput,
} from "../web/worker-lease-authorization";

test("streaming Start signing keeps raw pool inputs off disk and stdout", async () => {
  // Arrange
  const parent = await mkdtemp(
    join(tmpdir(), "bwg-worker-authority-stream-test-"),
  );
  const directory = join(parent, "authority");
  try {
    const init = Bun.spawn(
      [
        "bun",
        "scripts/worker-development-authority.ts",
        "init",
        "--directory",
        directory,
      ],
      { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" },
    );
    expect(await init.exited).toBe(0);
    const input = structuredClone(startInputFixture);
    const signer = Bun.spawn(
      [
        "bun",
        "scripts/worker-development-authority.ts",
        "sign-start",
        "--directory",
        directory,
        "--input",
        "-",
        "--output",
        "-",
      ],
      {
        cwd: import.meta.dir + "/..",
        stdin: new TextEncoder().encode(JSON.stringify(input)),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    // Act
    const [exitCode, stdout, stderr] = await Promise.all([
      signer.exited,
      new Response(signer.stdout).text(),
      new Response(signer.stderr).text(),
    ]);
    // Assert
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(stdout).not.toContain(input.request.stratum.password);
    const artifact = JSON.parse(stdout);
    expect(artifact.sequence).toBe("1");
    const trust = parseWorkerDeploymentTrust(
      JSON.parse(await readFile(join(directory, "trust.json"), "utf8")),
    );
    await expect(
      verifyWorkerLeaseAuthorization(
        artifact.authorization,
        input as WorkerLeaseAuthorizationInput,
        trust.workLeaseAuthority,
      ),
    ).resolves.toMatchObject({ sequence: 1n });
    const listing = await Array.fromAsync(
      new Bun.Glob("**/*").scan({ cwd: parent }),
    );
    expect(
      listing.every(
        (name) => name.startsWith("authority/") || name === "authority",
      ),
    ).toBeTrue();
  } finally {
    await rm(parent, { recursive: true });
  }
});

test("public trust export preserves role keys without rotating or exposing private keys", async () => {
  // Arrange
  const parent = await mkdtemp(
    join(tmpdir(), "bwg-worker-authority-public-test-"),
  );
  const directory = join(parent, "authority");
  try {
    const init = Bun.spawn(
      [
        "bun",
        "scripts/worker-development-authority.ts",
        "init",
        "--directory",
        directory,
      ],
      { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" },
    );
    expect(await init.exited).toBe(0);
    const before = await readFile(
      join(directory, "lease-sequence.json"),
      "utf8",
    );
    // Act
    const process = Bun.spawn(
      [
        "bun",
        "scripts/worker-development-authority.ts",
        "public-trust",
        "--directory",
        directory,
        "--output",
        "-",
      ],
      { cwd: import.meta.dir + "/..", stdout: "pipe", stderr: "pipe" },
    );
    const [code, stdout] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
    ]);
    // Assert
    expect(code).toBe(0);
    expect(stdout).not.toContain('"d":');
    expect(JSON.parse(stdout)).toEqual(
      JSON.parse(await readFile(join(directory, "trust.json"), "utf8")),
    );
    expect(await readFile(join(directory, "lease-sequence.json"), "utf8")).toBe(
      before,
    );
  } finally {
    await rm(parent, { recursive: true });
  }
});
