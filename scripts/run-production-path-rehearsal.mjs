// Drives the production-path rehearsal page (Ticket 06) through `playwright-cli run-code`.
// From challenge to redeemed Gate Pass: consent, Start, at least one Renew while
// shares are still being delivered, a new Bitcoin tip mid-lease that the lease
// survives, the synthetic share across the Work Requirement, restoration as `challenge_satisfied`
// confirmed after more than 30 s with no other command or refused Renew meanwhile, DPoP redemption, the serial port
// released and a refused replay. With `mode: "standard_worker"` in the rehearsal config, the claimant
// chooses "Use another Stratum V1 Worker" instead, the runner enters the settings the page shows into the
// CPU miner as a claimant would, and the Pool Adapter, not the page, cuts the miner off once the lease ends.
async (page) => {
  const WORK_TIMEOUT_MILLISECONDS = 120_000;
  const POLL_MILLISECONDS = 500;
  const messages = [];
  page.on("console", (message) => messages.push(`console: ${message.text()}`));
  page.on("pageerror", (error) => messages.push(`pageerror: ${error.message}`));
  const config = await page.evaluate(async () => (await fetch("/rehearsal-config")).json());
  const standard = config.mode === "standard_worker";
  // Past the 60 s credential cap, so a cut-off can't come from anything but the lease's end.
  const CUT_OFF_TIMEOUT_MILLISECONDS = 120_000;
  // `run-code` has no global `fetch`; the control listener is reached through `page.request`.
  const control = async (path, maybeBody) => {
    const url = `${config.control}${path}`;
    const response = maybeBody === undefined ? await page.request.get(url) : await page.request.post(url, { data: maybeBody });
    if (!response.ok() && response.status() !== 409) {
      throw new Error(`control ${path} failed: ${response.status()} ${await response.text()}`);
    }
    return response;
  };
  await page.exposeFunction("bwgRehearsalMiner", async (command, body) => {
    await control(`/miner/${command}`, body ?? {});
  });
  await page.addInitScript((pageConfig) => {
    window.bwgRehearsalConfig = pageConfig;
  }, {
    authorityTrust: config.authorityTrust,
    payoutAddress: config.payoutAddress,
    workers: [{ workerId: "rehearsal-cpu", displayName: "Rehearsal CPU miner", hashrateHs: "1000000" }],
    maybeStandardWorker: { workerId: "rehearsal-standard-cpu", displayName: "Your Stratum V1 Worker", hashrateHs: "1000000" },
    claimantWorkCeiling: "281474976710656",
    clientSafetyCeiling: "281474976710656",
    provenance: {
      sourceUrl: "https://github.com/bright-builds-llc/bitaxe-turnstile-system",
      protocolVersion: "BWG/0.1",
      appVersion: "rehearsal",
    },
  });
  const started = Date.now();
  const rehearsal = () => page.evaluate(() => structuredClone(window.bwgRehearsal));
  const fail = async (step, error) => {
    const state = await rehearsal().catch(() => undefined);
    throw new Error([`rehearsal step failed: ${step}`, String(error), JSON.stringify(state), ...messages.slice(-30)].join("\n"));
  };
  const until = async (step, check, timeout = WORK_TIMEOUT_MILLISECONDS) => {
    const deadline = Date.now() + timeout;
    for (;;) {
      const state = await rehearsal();
      if (state.maybeError) await fail(step, state.maybeError);
      const maybeValue = await check(state);
      if (maybeValue) return maybeValue;
      if (Date.now() > deadline) await fail(step, "timed out");
      await page.waitForTimeout(POLL_MILLISECONDS);
    }
  };

  await page.reload();
  await page.locator(standard ? "#use-stratum-worker" : "#connect-bitaxe").click();
  const created = await until("challenge created", (state) =>
    state.pageEvents.find((event) => event.type === "challenge_created"));
  const primary = page.locator("bwg-work-gate [data-action=primary]");
  await primary.waitFor({ state: "visible", timeout: 30_000 }).catch((error) => fail("consent shown", error));
  await until("consent enabled", async () => await primary.isEnabled());
  await primary.click();
  if (standard) {
    // The claimant copies the shown settings into their Worker.
    const settings = page.locator("#stratum-settings");
    await settings.waitFor({ state: "visible", timeout: 30_000 }).catch((error) => fail("settings shown", error));
    const field = (name) => settings.locator(`[data-field=${name}]`).textContent();
    await control("/miner/start", { endpoint: await field("endpoint"), username: await field("username"), password: await field("password") });
  }
  await until("mining", (state) => state.clientEvents.some((event) =>
    event.type === "lifecycle" && event.challengeState === "active" && event.controlState === "running"));

  const delivery = () => control(`/challenges/${created.challengeId}/delivery`).then((response) => response.json());
  const paused = (state) => state.clientEvents.filter((event) => event.type === "lifecycle").at(-1)?.controlState === "paused";
  const beforeSynthetic = await until("Renew while shares are delivered", async (state) => {
    if (paused(state)) await fail("mining continues", "the client paused");
    const minerNow = await (await control("/miner")).json();
    if (minerNow.difficultyRefused > 0) await fail("the miner accepts the pool difficulty", JSON.stringify(minerNow));
    const evidence = await delivery();
    const renewed = state.pageEvents.some((event) => event.type === "renewed");
    const deviceRenewed = standard || state.maybeDevice.renewals >= 1;
    return renewed && deviceRenewed && evidence.acknowledgedLeaseWindows >= 2 ? evidence : undefined;
  });
  const realProgress = await until("real shares advance Verified Progress", (state) => {
    const progress = state.clientEvents.filter((event) => event.type === "verified_progress");
    const latest = progress.at(-1);
    return latest && BigInt(latest.verifiedProgress) > 0n ? latest.verifiedProgress : undefined;
  });

  // A new tip retires the miner's job; its in-flight result is answered as stale and
  // the same lease keeps earning credit.
  const minerBeforeTip = await (await control("/miner")).json();
  const deliveryBeforeTip = await delivery();
  await control("/chain/block", {});
  const afterTip = await until("the lease survives a new Bitcoin tip", async (state) => {
    if (paused(state)) await fail("the lease survives a new Bitcoin tip", "the client paused");
    const [miner, evidence] = [await (await control("/miner")).json(), await delivery()];
    if (evidence.refused > deliveryBeforeTip.refused) {
      await fail("the lease survives a new Bitcoin tip", JSON.stringify(evidence));
    }
    const credited = evidence.realAcknowledged - deliveryBeforeTip.realAcknowledged;
    return miner.staleAnswered > minerBeforeTip.staleAnswered && credited >= 5
      ? { reconnects: miner.reconnects, staleAnswered: miner.staleAnswered, realSharesCreditedAfterTip: credited }
      : undefined;
  });

  await until("synthetic share queued", async () =>
    (await control(`/challenges/${created.challengeId}/synthetic-share`, {})).status() === 204);
  await until("Gate Pass redeemed", (state) =>
    state.pageEvents.find((event) => event.type === "redeemed"));
  const redeemedAt = Date.now();
  if (standard) {
    const cutOff = await until("the Pool Adapter cuts the Worker off after the lease", async () => {
      const minerNow = await (await control("/miner")).json();
      return minerNow.running ? undefined : { seconds: Math.round((Date.now() - redeemedAt) / 1000) };
    }, CUT_OFF_TIMEOUT_MILLISECONDS);
    return await standardEvidence(cutOff);
  }
  await until("serial port released after redemption", (state) => state.maybeDevice.portClosed);
  const final = await rehearsal();
  const redeemed = final.pageEvents.find((event) => event.type === "redeemed");
  if (redeemed.status !== 200) await fail("redemption accepted", JSON.stringify(redeemed));
  if (final.maybeDevice.restorationReason !== "challenge_satisfied") {
    await fail("restoration confirmed", final.maybeDevice.restorationReason);
  }
  const afterRestore = final.maybeDevice.commands.slice(final.maybeDevice.commands.indexOf("restore") + 1);
  if (!(final.maybeDevice.maybeRestorationConfirmedAfterMilliseconds > 30_000) || afterRestore.length > 0) {
    await fail("one slow restoration", JSON.stringify({
      confirmedAfter: final.maybeDevice.maybeRestorationConfirmedAfterMilliseconds,
      afterRestore,
    }));
  }
  // Renew stops on the Authority's terminal report, so no tick during the slow restore is refused.
  const renewRefusals = final.pageEvents.filter((event) => event.type === "renew_failed");
  if (renewRefusals.length > 0) await fail("Renew stops at the terminal state", JSON.stringify(renewRefusals));
  if (!final.maybeRedemptionBody) await fail("redemption captured for replay", "missing");
  const replayStatus = await page.evaluate(async (body) => (await fetch("/account-creation/redeem", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  })).status, final.maybeRedemptionBody);
  if (replayStatus < 400 || replayStatus >= 500) await fail("replayed Gate Pass refused", replayStatus);
  const miner = await (await control("/miner")).json();
  if (miner.running) await fail("miner stopped at the Work Requirement", JSON.stringify(miner));
  if (miner.difficultyRefused !== 0) await fail("the miner accepts the pool difficulty", JSON.stringify(miner));
  const afterSynthetic = await delivery();
  if (afterSynthetic.syntheticAcknowledged !== 1) await fail("one synthetic share", JSON.stringify(afterSynthetic));

  const evidence = {
    seconds: Math.round((Date.now() - started) / 1000),
    renewals: final.maybeDevice.renewals,
    realSharesAcknowledgedBeforeSynthetic: beforeSynthetic.realAcknowledged,
    leaseWindowsWithAcknowledgedShares: beforeSynthetic.acknowledgedLeaseWindows,
    verifiedProgressFromRealShares: realProgress,
    newTip: afterTip,
    delivery: afterSynthetic,
    minerAccepted: miner.accepted,
    minerRejected: miner.rejected,
    restoration: final.maybeDevice.restorationReason,
    restorationConfirmedAfterMilliseconds: final.maybeDevice.maybeRestorationConfirmedAfterMilliseconds,
    redemptionStatus: redeemed.status,
    portReleased: final.maybeDevice.portClosed,
    replayStatus,
  };
  return `rehearsal: passed\nrehearsal: evidence ${JSON.stringify(evidence)}`;

  // The same accounting and Redemption checks as the Bitaxe path, with the settings withdrawn in place of
  // a device's restoration.
  async function standardEvidence(cutOff) {
    const final = await rehearsal();
    const redeemed = final.pageEvents.find((event) => event.type === "redeemed");
    if (redeemed.status !== 200) await fail("redemption accepted", JSON.stringify(redeemed));
    if (final.standardSettingsShown.join() !== "true,false" && final.standardSettingsShown.join() !== "false,true,false") {
      await fail("settings shown once, then withdrawn", JSON.stringify(final.standardSettingsShown));
    }
    if (!(await page.locator("#stratum-settings").isHidden())) await fail("settings hidden after the lease", "visible");
    const renewRefusals = final.pageEvents.filter((event) => event.type === "renew_failed");
    if (renewRefusals.length > 0) await fail("Renew stops at the terminal state", JSON.stringify(renewRefusals));
    if (!final.maybeRedemptionBody) await fail("redemption captured for replay", "missing");
    const replayStatus = await page.evaluate(async (body) => (await fetch("/account-creation/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    })).status, final.maybeRedemptionBody);
    if (replayStatus < 400 || replayStatus >= 500) await fail("replayed Gate Pass refused", replayStatus);
    const miner = await (await control("/miner")).json();
    if (miner.difficultyRefused !== 0) await fail("the miner accepts the pool difficulty", JSON.stringify(miner));
    const afterSynthetic = await delivery();
    if (afterSynthetic.syntheticAcknowledged !== 1) await fail("one synthetic share", JSON.stringify(afterSynthetic));
    const evidence = {
      worker: "standard_stratum_v1",
      seconds: Math.round((Date.now() - started) / 1000),
      renewals: final.pageEvents.filter((event) => event.type === "renewed").length,
      realSharesAcknowledgedBeforeSynthetic: beforeSynthetic.realAcknowledged,
      leaseWindowsWithAcknowledgedShares: beforeSynthetic.acknowledgedLeaseWindows,
      verifiedProgressFromRealShares: realProgress,
      newTip: afterTip,
      delivery: afterSynthetic,
      minerAccepted: miner.accepted,
      minerRejected: miner.rejected,
      settingsShown: final.standardSettingsShown,
      cutOffAfterRedemptionSeconds: cutOff.seconds,
      redemptionStatus: redeemed.status,
      replayStatus,
    };
    return `rehearsal: passed\nrehearsal: evidence ${JSON.stringify(evidence)}`;
  }
}
