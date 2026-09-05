import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import controllerFixtures from "../conformance/bwg-worker-controller-0.4/fixtures.json";
import usbFixtures from "../conformance/bwg-worker-serial-0.1/fixtures.json";
import startInputFixture from "../conformance/bwg-worker-deployment-trust-0.2/start-input.json";
import { parseWorkerDeploymentTrust } from "../web/worker-deployment-trust";
import { verifyWorkerControllerCapability } from "../web/worker-controller";
import { parseWorkerSerialManifest } from "../web/worker-serial";
import {
  verifyWorkerLeaseAuthorization,
  type WorkerLeaseAuthorizationInput,
} from "../web/worker-lease-authorization";

test("initializes separate protected development authority keys without printing them", async () => {
  // Arrange
  const parent = await mkdtemp(join(tmpdir(), "bwg-worker-authority-test-"));
  const directory = join(parent, "authority");

  try {
    // Act
    const process = Bun.spawn(
      [
        "bun",
        "scripts/worker-development-authority.ts",
        "init",
        "--directory",
        directory,
      ],
      {
        cwd: import.meta.dir + "/..",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);

    // Assert
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(stdout).toContain("development_authority=initialized");
    const updatePrivate = await readFile(
      join(directory, "update-private.json"),
      "utf8",
    );
    const leasePrivate = await readFile(
      join(directory, "lease-private.json"),
      "utf8",
    );
    const trust = await readFile(join(directory, "trust.json"), "utf8");
    expect(updatePrivate).toContain('"d":');
    expect(leasePrivate).toContain('"d":');
    expect(trust).not.toContain('"d":');
    expect(stdout).not.toContain('"d":');
    expect((await stat(directory)).mode & 0o077).toBe(0);
    expect(
      (await stat(join(directory, "update-private.json"))).mode & 0o077,
    ).toBe(0);
    expect(
      (await stat(join(directory, "lease-private.json"))).mode & 0o077,
    ).toBe(0);
    expect(JSON.parse(updatePrivate).activeKid).not.toBe(
      JSON.parse(leasePrivate).activeKid,
    );
  } finally {
    await rm(parent, { recursive: true });
  }
});

test("allocates and signs one full-input Start authorization without stdout secrets", async () => {
  // Arrange
  const parent = await mkdtemp(
    join(tmpdir(), "bwg-worker-authority-sign-test-"),
  );
  const directory = join(parent, "authority");
  const inputPath = join(parent, "start.private.json");
  const outputPath = join(parent, "authorization.private.json");
  const input: WorkerLeaseAuthorizationInput = {
    operation: "start",
    activeChallengeId: "challenge_00000000000000000000000000000001",
    controlSessionBindingSha256: "S".repeat(43),
    request: {
      protocolVersion: "bwg-worker-controller/0.4",
      leaseId: "lease_fixture_03",
      challengeId: "challenge_00000000000000000000000000000001",
      durationMilliseconds: 60_000,
      renewAfterMilliseconds: 20_000,
      stratum: {
        endpoint: "stratum+tcp://127.0.0.1:3333/",
        username: "fixture-session-user",
        password: "fixture-session-password",
      },
    },
  };

  try {
    await run(["init", "--directory", directory]);
    await writeFile(inputPath, JSON.stringify(input), { mode: 0o600 });
    await chmod(inputPath, 0o600);

    // Act
    const result = await run([
      "sign-start",
      "--directory",
      directory,
      "--input",
      inputPath,
      "--output",
      outputPath,
    ]);

    // Assert
    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "worker_lease_authorization=signed operation=start\n",
    });
    expect(result.stdout).not.toMatch(/fixture-session|authorization\"/i);
    expect((await stat(outputPath)).mode & 0o077).toBe(0);
    const artifact = JSON.parse(await readFile(outputPath, "utf8"));
    const trust = parseWorkerDeploymentTrust(
      JSON.parse(await readFile(join(directory, "trust.json"), "utf8")),
    );
    await expect(
      verifyWorkerLeaseAuthorization(
        artifact.authorization,
        input,
        trust.workLeaseAuthority,
      ),
    ).resolves.toEqual({
      keyId: trust.workLeaseAuthority.keys[0]?.kid,
      sequence: 1n,
    });
  } finally {
    await rm(parent, { recursive: true });
  }
});

test("signs the exact Ultra 205 capability with the separate Update Authority", async () => {
  // Arrange
  const parent = await mkdtemp(
    join(tmpdir(), "bwg-worker-capability-sign-test-"),
  );
  const directory = join(parent, "authority");
  const inputPath = join(parent, "capability.json");
  const outputPath = join(parent, "signed-capability.json");
  const { attestation: _attestation, ...fixtureCapability } =
    controllerFixtures.capabilities;
  const input = {
    capability: {
      ...fixtureCapability,
      board: {
        model: "bitaxe-ultra",
        revision: "205",
        usbTransport: "web_serial",
      },
    },
    manifest: usbFixtures.manifest,
  };

  try {
    await run(["init", "--directory", directory]);
    await writeFile(inputPath, JSON.stringify(input), { mode: 0o644 });

    // Act
    const result = await run([
      "sign-capability",
      "--directory",
      directory,
      "--input",
      inputPath,
      "--output",
      outputPath,
    ]);

    // Assert
    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "worker_capability=signed board=205\n",
    });
    const trust = parseWorkerDeploymentTrust(
      JSON.parse(await readFile(join(directory, "trust.json"), "utf8")),
    );
    const capability = JSON.parse(await readFile(outputPath, "utf8"));
    await expect(
      verifyWorkerControllerCapability(
        capability,
        parseWorkerSerialManifest(input.manifest),
        trust.updateAuthority.keys,
      ),
    ).resolves.toMatchObject({
      board: { model: "bitaxe-ultra", revision: "205" },
    });
  } finally {
    await rm(parent, { recursive: true });
  }
});

test("rotates with overlap and retires only an explicitly named inactive key", async () => {
  // Arrange
  const parent = await mkdtemp(join(tmpdir(), "bwg-worker-rotation-test-"));
  const directory = join(parent, "authority");
  const startInputPath = join(parent, "start.private.json");
  const startOutputPath = join(parent, "start-authorization.private.json");
  const capabilityInputPath = join(parent, "capability.json");
  const capabilityOutputPath = join(parent, "signed-capability.json");

  try {
    await run(["init", "--directory", directory]);
    const initial = JSON.parse(
      await readFile(join(directory, "trust.json"), "utf8"),
    );
    const oldUpdateKid = initial.updateAuthority.keys[0].kid;
    const oldLeaseKid = initial.workLeaseAuthority.keys[0].kid;
    const startInput = structuredClone(
      startInputFixture,
    ) as WorkerLeaseAuthorizationInput;
    await writeFile(startInputPath, JSON.stringify(startInput), {
      mode: 0o600,
    });
    await chmod(startInputPath, 0o600);
    await writeFile(
      capabilityInputPath,
      await readFile(
        join(
          import.meta.dir,
          "../conformance/bwg-worker-deployment-trust-0.2/ultra205-capability-input.json",
        ),
      ),
      { mode: 0o644 },
    );
    await run([
      "sign-start",
      "--directory",
      directory,
      "--input",
      startInputPath,
      "--output",
      startOutputPath,
    ]);
    await run([
      "sign-capability",
      "--directory",
      directory,
      "--input",
      capabilityInputPath,
      "--output",
      capabilityOutputPath,
    ]);
    const oldAuthorization = JSON.parse(
      await readFile(startOutputPath, "utf8"),
    );
    const oldCapability = JSON.parse(
      await readFile(capabilityOutputPath, "utf8"),
    );

    // Act
    await expect(
      run(["rotate", "--directory", directory, "--role", "update"]),
    ).resolves.toMatchObject({ exitCode: 0, stderr: "" });
    await expect(
      run(["rotate", "--directory", directory, "--role", "lease"]),
    ).resolves.toMatchObject({ exitCode: 0, stderr: "" });
    const overlapped = JSON.parse(
      await readFile(join(directory, "trust.json"), "utf8"),
    );
    const overlapTrust = parseWorkerDeploymentTrust(overlapped);
    await expect(
      verifyWorkerLeaseAuthorization(
        oldAuthorization.authorization,
        startInput,
        overlapTrust.workLeaseAuthority,
      ),
    ).resolves.toMatchObject({ keyId: oldLeaseKid });
    await expect(
      verifyWorkerControllerCapability(
        oldCapability,
        parseWorkerSerialManifest(
          JSON.parse(await readFile(capabilityInputPath, "utf8")).manifest,
        ),
        overlapTrust.updateAuthority.keys,
      ),
    ).resolves.toMatchObject({ board: { revision: "205" } });
    await expect(
      run([
        "retire",
        "--directory",
        directory,
        "--role",
        "update",
        "--kid",
        oldUpdateKid,
        "--confirm-destructive-retirement",
        oldUpdateKid,
      ]),
    ).resolves.toMatchObject({ exitCode: 0, stderr: "" });
    await expect(
      run([
        "retire",
        "--directory",
        directory,
        "--role",
        "lease",
        "--kid",
        oldLeaseKid,
        "--confirm-destructive-retirement",
        oldLeaseKid,
      ]),
    ).resolves.toMatchObject({ exitCode: 0, stderr: "" });

    // Assert
    expect(overlapped.updateAuthority.keys).toHaveLength(2);
    expect(overlapped.workLeaseAuthority.keys).toHaveLength(2);
    const retired = JSON.parse(
      await readFile(join(directory, "trust.json"), "utf8"),
    );
    expect(retired.updateAuthority.keys).toHaveLength(1);
    expect(retired.workLeaseAuthority.keys).toHaveLength(1);
    const sequences = JSON.parse(
      await readFile(join(directory, "lease-sequence.json"), "utf8"),
    ).sequences;
    expect(sequences[oldLeaseKid]).toBeUndefined();
    const retiredTrust = parseWorkerDeploymentTrust(retired);
    await expect(
      verifyWorkerLeaseAuthorization(
        oldAuthorization.authorization,
        startInput,
        retiredTrust.workLeaseAuthority,
      ),
    ).rejects.toThrow("Worker Lease authorization is invalid");
    await expect(
      verifyWorkerControllerCapability(
        oldCapability,
        parseWorkerSerialManifest(
          JSON.parse(await readFile(capabilityInputPath, "utf8")).manifest,
        ),
        retiredTrust.updateAuthority.keys,
      ),
    ).rejects.toThrow("capability attestation is invalid");
  } finally {
    await rm(parent, { recursive: true });
  }
});

test("concurrent signers never reuse a durable Work Lease sequence", async () => {
  // Arrange
  const parent = await mkdtemp(
    join(tmpdir(), "bwg-worker-sequence-race-test-"),
  );
  const directory = join(parent, "authority");
  const inputPath = join(parent, "start.private.json");
  const input: WorkerLeaseAuthorizationInput = {
    operation: "start",
    activeChallengeId: "challenge_00000000000000000000000000000001",
    controlSessionBindingSha256: "S".repeat(43),
    request: {
      protocolVersion: "bwg-worker-controller/0.4",
      leaseId: "lease_fixture_03",
      challengeId: "challenge_00000000000000000000000000000001",
      durationMilliseconds: 60_000,
      renewAfterMilliseconds: 20_000,
      stratum: {
        endpoint: "stratum+tcp://127.0.0.1:3333/",
        username: "fixture-session-user",
        password: "fixture-session-password",
      },
    },
  };

  try {
    await run(["init", "--directory", directory]);
    await writeFile(inputPath, JSON.stringify(input), { mode: 0o600 });
    await chmod(inputPath, 0o600);

    // Act
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        run([
          "sign-start",
          "--directory",
          directory,
          "--input",
          inputPath,
          "--output",
          join(parent, `authorization-${String(index)}.json`),
        ]),
      ),
    );
    const successfulSequences: string[] = [];
    for (const [index, result] of results.entries()) {
      if (result.exitCode !== 0) continue;
      const artifact = JSON.parse(
        await readFile(
          join(parent, `authorization-${String(index)}.json`),
          "utf8",
        ),
      );
      successfulSequences.push(artifact.sequence);
    }

    // Assert
    expect(successfulSequences.length).toBeGreaterThan(0);
    expect(new Set(successfulSequences).size).toBe(successfulSequences.length);
  } finally {
    await rm(parent, { recursive: true });
  }
});

test("revalidates that private authority operations remain outside Git", async () => {
  // Arrange
  const parent = await mkdtemp(
    join(tmpdir(), "bwg-worker-moved-authority-test-"),
  );
  const original = join(parent, "authority");
  const repository = join(parent, "repository");
  const moved = join(repository, "authority");

  try {
    await run(["init", "--directory", original]);
    await mkdir(join(repository, ".git"), { recursive: true });
    await rename(original, moved);

    // Act
    const result = await run([
      "rotate",
      "--directory",
      moved,
      "--role",
      "update",
    ]);

    // Assert
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("category=invalid_operation");
  } finally {
    await rm(parent, { recursive: true });
  }
});

test("recovers a journaled rotation before the next private-key operation", async () => {
  // Arrange
  const parent = await mkdtemp(join(tmpdir(), "bwg-worker-journal-test-"));
  const directory = join(parent, "authority");
  const inputPath = join(parent, "capability.json");
  const outputPath = join(parent, "signed-capability.json");
  await writeFile(
    inputPath,
    await readFile(
      join(
        import.meta.dir,
        "../conformance/bwg-worker-deployment-trust-0.2/ultra205-capability-input.json",
      ),
    ),
    { mode: 0o644 },
  );

  try {
    await run(["init", "--directory", directory]);
    const interrupted = await run(
      ["rotate", "--directory", directory, "--role", "update"],
      { BWG_WORKER_AUTHORITY_FAIL_AFTER: "after_trust" },
    );

    // Act
    const recovered = await run([
      "sign-capability",
      "--directory",
      directory,
      "--input",
      inputPath,
      "--output",
      outputPath,
    ]);

    // Assert
    expect(interrupted.exitCode).toBe(1);
    expect(recovered.exitCode).toBe(0);
    const trust = parseWorkerDeploymentTrust(
      JSON.parse(await readFile(join(directory, "trust.json"), "utf8")),
    );
    expect(trust.updateAuthority.keys).toHaveLength(2);
    await expect(
      stat(join(directory, "authority-journal.json")),
    ).rejects.toThrow();
    await expect(
      verifyWorkerControllerCapability(
        JSON.parse(await readFile(outputPath, "utf8")),
        parseWorkerSerialManifest(
          JSON.parse(await readFile(inputPath, "utf8")).manifest,
        ),
        trust.updateAuthority.keys,
      ),
    ).resolves.toMatchObject({ board: { revision: "205" } });
  } finally {
    await rm(parent, { recursive: true });
  }
});

test("serializes concurrent authority rotations without losing either key", async () => {
  // Arrange
  const parent = await mkdtemp(
    join(tmpdir(), "bwg-worker-rotation-race-test-"),
  );
  const directory = join(parent, "authority");

  try {
    await run(["init", "--directory", directory]);

    // Act
    const results = await Promise.all([
      run(["rotate", "--directory", directory, "--role", "update"]),
      run(["rotate", "--directory", directory, "--role", "update"]),
    ]);

    // Assert
    expect(results.map((result) => result.exitCode)).toEqual([0, 0]);
    const trust = parseWorkerDeploymentTrust(
      JSON.parse(await readFile(join(directory, "trust.json"), "utf8")),
    );
    expect(trust.updateAuthority.keys).toHaveLength(3);
  } finally {
    await rm(parent, { recursive: true });
  }
});

test("fails closed instead of wrapping an exhausted durable sequence", async () => {
  // Arrange
  const parent = await mkdtemp(
    join(tmpdir(), "bwg-worker-sequence-limit-test-"),
  );
  const directory = join(parent, "authority");
  const inputPath = join(parent, "start.private.json");
  const outputPath = join(parent, "authorization.private.json");
  const input = structuredClone(
    startInputFixture,
  ) as WorkerLeaseAuthorizationInput;

  try {
    await run(["init", "--directory", directory]);
    await writeFile(inputPath, JSON.stringify(input), { mode: 0o600 });
    const trust = JSON.parse(
      await readFile(join(directory, "trust.json"), "utf8"),
    );
    await writeFile(
      join(directory, "lease-sequence.json"),
      JSON.stringify({
        profile: "bwg-worker-lease-sequence/0.1",
        sequences: {
          [trust.workLeaseAuthority.keys[0].kid]: "18446744073709551615",
        },
      }),
      { mode: 0o600 },
    );

    // Act
    const result = await run([
      "sign-start",
      "--directory",
      directory,
      "--input",
      inputPath,
      "--output",
      outputPath,
    ]);

    // Assert
    expect(result.exitCode).toBe(1);
    await expect(stat(outputPath)).rejects.toThrow();
  } finally {
    await rm(parent, { recursive: true });
  }
});

async function run(
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {},
) {
  const child = Bun.spawn(
    ["bun", "scripts/worker-development-authority.ts", ...args],
    {
      cwd: import.meta.dir + "/..",
      env: { ...globalThis.process.env, ...environment },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}
