/** Bounded same-origin qualification responses; private bytes are wiped before release. */
export async function acceptanceLocalJson(path: string, body?: object): Promise<any> {
  try {
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      cache: "no-store",
      credentials: "omit",
      ...(body === undefined
        ? {}
        : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
    });
    if (!response.ok || !response.body) throw new Error("local_response");
    const reader = response.body.getReader();
    const bytes = new Uint8Array(65_536);
    let length = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (length + value.length > bytes.length)
          throw new Error("local_bound");
        bytes.set(value, length);
        length += value.length;
      }
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, length),
        ),
      );
    } finally {
      bytes.fill(0);
      reader.releaseLock();
    }
  } catch {
    throw new Error("local_input_invalid");
  }
}
