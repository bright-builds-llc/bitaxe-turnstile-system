async (page) => {
  await page.locator("body[data-harness=ready]").waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: "Connect reference Worker" }).click();
  await page.getByRole("button", { name: "Check wrong USB device" }).click();
  await page.getByRole("button", { name: "Check wrong USB function" }).click();
  await page.getByRole("button", { name: "Check Worker reacquisition" }).click();
  await page.getByRole("button", { name: "Check durable Worker recovery" }).click();
  await page.getByRole("button", { name: "Check atomic Worker admission" }).click();
  await page.locator("[data-status=passed], [data-status=failed]").waitFor({ timeout: 10_000 });

  const result = await page.locator("#result").getAttribute("data-status");
  if (result !== "passed") {
    throw new Error(
      `Worker WebUSB browser conformance failed: ${await page.locator("#details").innerText()}`,
    );
  }

  const statusRole = await page.getByRole("status").count();
  const namedButtons = await page.getByRole("button").allTextContents();
  if (
    statusRole !== 1 ||
    namedButtons.length !== 6 ||
    namedButtons.some((name) => name.trim() === "")
  ) {
    throw new Error("Worker WebUSB browser conformance accessibility failed");
  }
}
