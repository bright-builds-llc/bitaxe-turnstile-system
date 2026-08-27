type ClosableSession = {
  client: { close(): Promise<void> };
};

export async function replaceSessionAfterClosingPrevious<T extends ClosableSession>(
  previous: T | undefined,
  replacement: T,
  commit: () => void,
): Promise<void> {
  if (!previous || previous.client === replacement.client) {
    commit();
    return;
  }
  try {
    await previous.client.close();
  } catch (previousCloseError) {
    try {
      await replacement.client.close();
    } catch (replacementCloseError) {
      throw new AggregateError(
        [previousCloseError, replacementCloseError],
        "Previous and replacement Worker shutdown both failed",
      );
    }
    throw previousCloseError;
  }
  commit();
}

export function closeSessionDuringCleanup(session: ClosableSession | undefined): void {
  const maybeClose = session?.client.close();
  if (!maybeClose) return;
  void maybeClose.catch(() => {
    console.error("Worker shutdown failed during component cleanup");
  });
}
