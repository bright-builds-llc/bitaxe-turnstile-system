import { expect, test } from "bun:test";

test("the actual page preserves its private baseline across close and firmware reconfiguration", async () => {
  // Arrange: isolate the module mock so production-adapter tests retain their real implementation.
  const process = Bun.spawn(["bun", new URL("./worker-restart-page-lifecycle.fixture.ts", import.meta.url).pathname], { stdout: "pipe", stderr: "pipe" });
  // Act
  const [code, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
  // Assert
  expect(stderr).toBe(""); expect(code).toBe(0);
});
