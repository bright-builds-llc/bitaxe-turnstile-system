async (page) => {
  // Ticket 29: one browser profile admits one Worker Serial session; another profile has its own lock.
  const ready = (target) => target.waitForFunction(() => typeof window.tryWorkerSerialLock === "function");
  const attempt = (target) => target.evaluate(() => window.tryWorkerSerialLock());
  await ready(page);
  if ((await attempt(page)) !== "held") throw new Error("the first tab did not take the lock");
  const secondTab = await page.context().newPage();
  await secondTab.goto(page.url());
  await ready(secondTab);
  const sameProfile = await attempt(secondTab);
  await secondTab.close();
  if (sameProfile !== "already_owned") throw new Error(`a second tab in the same profile got ${sameProfile}`);
  const maybeBrowser = page.context().browser();
  if (!maybeBrowser) throw new Error("no browser handle to open a second profile");
  const otherProfile = await maybeBrowser.newContext();
  const otherTab = await otherProfile.newPage();
  await otherTab.goto(page.url());
  await ready(otherTab);
  const ownProfile = await attempt(otherTab);
  await otherProfile.close();
  if (ownProfile !== "held") throw new Error(`a tab in a second profile got ${ownProfile}`);
  await page.locator("#result").evaluate((element) => { element.textContent = "status passed"; });
}
