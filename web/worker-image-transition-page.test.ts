import { expect, test } from "bun:test";

test.each(["changed_image", "same_boot", "rollback_boot", "same_image", "active", "fenced", "wrong_identity", "self_test_restart", "before_idle", "old_replay", "old_mutation", "ordinary_reconnect", "preservation_mismatch"])("actual page and serial controller planned image history: %s", async scenario => {
  // Arrange: isolate page globals while retaining real serial and signed possession admission.
  const child = Bun.spawn(["bun", new URL("./worker-image-transition-page.fixture.ts", import.meta.url).pathname, scenario], { stdout: "pipe", stderr: "pipe" });
  // Act
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  // Assert
  expect(stderr).toBe(""); expect(code).toBe(0);
});
