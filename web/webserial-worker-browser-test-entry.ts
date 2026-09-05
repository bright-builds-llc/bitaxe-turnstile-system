import { serialHarness } from "./worker-serial.test-support";
/** Browser conformance runs the production adapter through real Streams and WebCrypto. */
export async function runWorkerSerialBrowserConformance(): Promise<void> {
  const h = await serialHarness();
  await h.controller.requestPermission();
  const probe = await h.controller.transportProbe();
  if (Math.max(probe.requestPayloadBytes, probe.responsePayloadBytes) !== 65536)
    throw new Error("maximum frame was not exercised");
  const grant = await h.grant(
    await h.controller.prepareWorkerLeaseAuthorizationContext("start"),
  );
  if ((await h.controller.startLease(grant)).state !== "mining")
    throw new Error("signed Start failed");
  await h.advance(1000);
  await h.hide();
  await h.advance(3000);
  if (h.counts().locked || h.counts().closed !== 1)
    throw new Error("foreground cleanup failed");
  h.show();
  let rejected = false;
  try {
    await h.controller.status();
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("implicit resume allowed");
  await h.controller.requestPermission();
  await h.controller.close();
}
