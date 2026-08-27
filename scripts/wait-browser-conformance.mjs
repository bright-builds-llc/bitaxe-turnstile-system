async (page) => {
  await page.locator("[data-status=passed], [data-status=failed]").waitFor({ timeout: 10_000 });
}
