async (page) => {
  const messages = [];
  page.on("console", (message) => messages.push(`console: ${message.text()}`));
  page.on("pageerror", (error) => messages.push(`pageerror: ${error.message}`));
  page.context().on("page", (openedPage) => {
    openedPage.on("console", (message) => messages.push(`popup console: ${message.text()}`));
    openedPage.on("pageerror", (error) => messages.push(`popup pageerror: ${error.message}`));
    void addVirtualAuthenticator(openedPage).catch((error) => {
      messages.push(`popup authenticator: ${String(error)}`);
    });
  });
  const staticOrigin = page.url().split("/").slice(0, 3).join("/").replace(
    "127.0.0.1",
    "localhost",
  );
  const url = "https://app.relying.example/conformance/bwg-0.1/trusted-consent-browser.html";
  const fixtureUpstream = await page.evaluate(async () => {
    const response = await fetch("/fixture-upstream");
    if (!response.ok) throw new Error("trusted-consent fixture upstream is unavailable");
    return response.text();
  });
  let maybeWireMutation;
  let beginCalls = 0;
  await page.context().route("https://authority.example/**", async (route) => {
    const requested = route.request().url();
    const pathAndQuery = requested.slice("https://authority.example".length);
    const pathname = pathAndQuery.split("?", 1)[0];
    const response = await route.fetch({
      url: `${fixtureUpstream}${pathAndQuery}`,
    });
    if (
      route.request().method() === "POST" &&
      /^\/v0\/challenges\/[^/]+\/trusted-consent$/u.test(pathname)
    ) {
      beginCalls += 1;
    }
    if (
      maybeWireMutation &&
      route.request().method() === "GET" &&
      /^\/v0\/challenges\/[^/]+\/trusted-consent$/u.test(pathname)
    ) {
      const body = await response.json();
      const offer = body.challenge.pool_offers.offers[0];
      if (maybeWireMutation === "enum") offer.mining_transport = "stratum_v2";
      if (maybeWireMutation === "boolean") {
        offer.reward_policy.creates_custodial_balance = true;
      }
      if (maybeWireMutation === "destinations") {
        offer.payout_requirements.accepted_destination_types = ["bitcoin_mainnet_address"];
      }
      maybeWireMutation = undefined;
      await route.fulfill({ response, json: body });
      return;
    }
    await route.fulfill({ response });
  });
  await page.context().route("https://app.relying.example/**", async (route) => {
    const requested = route.request().url();
    const pathAndQuery = requested.slice("https://app.relying.example".length);
    const response = await route.fetch({ url: `${staticOrigin}${pathAndQuery}` });
    await route.fulfill({ response });
  });
  await addVirtualAuthenticator(page);
  async function addVirtualAuthenticator(targetPage) {
    const cdp = await page.context().newCDPSession(targetPage);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
    });
  }
  await page.goto("https://authority.example/fixture/config");
  const fixtureBody = await page.locator("body").textContent();
  if (!fixtureBody) throw new Error("trusted-consent fixture config is empty");
  const fixtureConfig = JSON.parse(fixtureBody);
  const challengeId = fixtureConfig.descriptor.challenge_id;
  for (const mutation of ["enum", "boolean", "destinations"]) {
    const beginCallsBefore = beginCalls;
    maybeWireMutation = mutation;
    const testPage = await page.context().newPage();
    const testUrl = "https://authority.example/v0/trusted-consent" +
      `?state=wire-${mutation}` +
      "&opener_origin=https%3A%2F%2Fapp.relying.example" +
      "&reason=elevated_work" +
      `&challenge_id=${challengeId}` +
      `&disclosure_digest=${"A".repeat(43)}` +
      `&pool_offer_set_signature_digest=${"A".repeat(43)}`;
    await testPage.goto(testUrl);
    await testPage.waitForFunction(
      () => document.querySelector("#status")?.textContent?.includes("invalid"),
      undefined,
      { timeout: 5_000 },
    );
    if (beginCalls !== beginCallsBefore) {
      throw new Error(`wire-${mutation}: WebAuthn begin was reached`);
    }
    await testPage.close();
  }
  await page.goto(url);
  try {
    await page.locator("[data-status=passed]").waitFor({ timeout: 10_000 });
  } catch (error) {
    const details = await page.locator("#details").textContent();
    const status = await page.locator("#result").textContent();
    throw new Error([`status: ${status}`, details, ...messages, String(error)].filter(Boolean).join("\n"));
  }
}
