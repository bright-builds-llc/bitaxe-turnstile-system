import { expect, test } from "bun:test";

test.each(["scope_replay", "expiry_close", "renewal_replay", "acceptance_config", "admission_diagnostic"])("real restoration page/controller boundary: %s", async scenario => {
  // Arrange: isolate page module mocks; its controller, protocol and signature checks remain real.
  const child = Bun.spawn(["bun", new URL("./worker-restoration-page.fixture.ts", import.meta.url).pathname, scenario], { stdout: "pipe", stderr: "pipe" });
  // Act
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  // Assert
  expect(stderr).toBe(""); expect(code).toBe(0);
});
