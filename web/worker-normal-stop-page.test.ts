import { expect, test } from "bun:test";

test.each(["heartbeat_fault", "idle_restart", "missing_start_preservation", "matched", "advance_before_stop", "rollback_after_mismatch", "missing_stop_preservation", "wrong_stop_generation", "advance_after_close", "wrong_reconnect_generation", "missing_reconnect_preservation"])("real normal Stop page/controller authorization boundary: %s", async scenario => {
  // Arrange: isolate page module mocks; its controller, protocol and signature checks remain real.
  const child = Bun.spawn(["bun", new URL("./worker-normal-stop-page.fixture.ts", import.meta.url).pathname, scenario], { stdout: "pipe", stderr: "pipe" });
  // Act
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  // Assert
  expect(stderr).toBe(""); expect(code).toBe(0);
});
