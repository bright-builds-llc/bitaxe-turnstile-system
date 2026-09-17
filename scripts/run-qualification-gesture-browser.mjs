async (page) => {
  await page.waitForFunction(() => typeof window.gestureSnapshot === "function");
  // A DOM-generated click cannot turn ambient user activation into a trusted gesture.
  await page.evaluate(() => document.querySelector("#connect").click());
  const blocked = await page.evaluate(() => window.gestureSnapshot());
  if (blocked.calls !== 0 || blocked.failures !== 0 || blocked.state !== "unchanged acceptance state" ||
      blocked.notice !== "Bring this qualification page to the foreground, then click Connect." || !blocked.noticeOutsideState)
    throw new Error("synthetic Connect was not an inert local precondition");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const admitted = await page.evaluate(() => window.gestureSnapshot());
  if (admitted.calls !== 1 || admitted.failures !== 0 || !admitted.synchronous || admitted.notice !== "" ||
      admitted.state !== "unchanged acceptance state") throw new Error("trusted Connect did not invoke synchronously");
  const runtime = JSON.parse(await page.locator("#result").textContent());
  if (!runtime.active || !runtime.focused || runtime.visible !== "visible") throw new Error("browser gesture predicates were absent");
  await page.evaluate(() => document.querySelector("#connect").click());
  if ((await page.evaluate(() => window.gestureSnapshot())).calls !== 1) throw new Error("programmatic click reused activation");
  await page.locator("#result").evaluate(element => { element.textContent = "status passed"; });
}
