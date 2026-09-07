import { expect, test } from "bun:test";
import fixtures from "../conformance/bwg-worker-serial-0.2/integrity-vectors.json";
import { WorkerSerialFramer, WORKER_SERIAL_PROFILE, encodeWorkerSerialEnvelope } from "./worker-serial";

test.each(fixtures.vectors)("exact lexical payload integrity: $id", async vector => {
  // Arrange: deliberately vary the envelope's own order and escaped payload key.
  const wire = ` {"sequence":1,"payloadSha256":"${vector.payloadSha256}","sessionId":"AAAAAAAAAAAAAAAAAAAAAA","kind":"control","profile":"${WORKER_SERIAL_PROFILE}","payloadBytes":${vector.payloadBytes},"paylo\\u0061d": ${vector.payloadJson} }\n`;
  // Act
  const frames = await new WorkerSerialFramer().push(new TextEncoder().encode(wire));
  // Assert
  expect(frames[0]?.payload).toEqual(JSON.parse(vector.payloadJson));
});

test.each(["length", "digest", "removed", "duplicated"])("corrupt %s is rejected before dispatch", async mutation => {
  // Arrange
  const bytes = await encodeWorkerSerialEnvelope({ profile: WORKER_SERIAL_PROFILE, kind: "control", sequence: 1, sessionId: "AAAAAAAAAAAAAAAAAAAAAA", payload: { padding: "xxxxxxxx" } });
  let text = new TextDecoder().decode(bytes);
  if (mutation === "length") text = text.replace('"payloadBytes":22', '"payloadBytes":21');
  if (mutation === "digest") text = text.replace(/"payloadSha256":"[^"]+"/u, '"payloadSha256":"' + "A".repeat(43) + '"');
  if (mutation === "removed") text = text.replace("xxxxxxxx", "xxxxxxx");
  if (mutation === "duplicated") text = text.replace("xxxxxxxx", "xxxxxxxxx");
  // Act / Assert
  await expect(new WorkerSerialFramer().push(new TextEncoder().encode(text))).rejects.toMatchObject({ category: "integrity" });
});

test("payload mutation during hashing cannot change the encoded payload", async () => {
  // Arrange
  const payload = { padding: "original" };
  // Act
  const encoding = encodeWorkerSerialEnvelope({ profile: WORKER_SERIAL_PROFILE, kind: "control", sequence: 1, sessionId: "AAAAAAAAAAAAAAAAAAAAAA", payload });
  payload.padding = "changed";
  const frames = await new WorkerSerialFramer().push(await encoding);
  // Assert
  expect(frames[0]?.payload).toEqual({ padding: "original" });
});
