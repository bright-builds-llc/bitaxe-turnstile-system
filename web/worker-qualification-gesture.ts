/** A local precondition notice: never projected into acceptance evidence or device state. */
export const WORKER_QUALIFICATION_GESTURE_NOTICE = "Bring this qualification page to the foreground, then click Connect.";
export type WorkerConnectGesture = {
  qualification: boolean;
  trusted: boolean;
  visible: boolean;
  focused: boolean;
  active: boolean;
};

/** Qualified Connect stays in the trusted event task; ordinary UI scheduling is unchanged. */
export function maybeInvokeWorkerConnectGesture(
  gesture: WorkerConnectGesture,
  connect: () => Promise<unknown>,
  notice: (message: string) => void,
): Promise<unknown> | undefined {
  if (!gesture.qualification) return Promise.resolve().then(connect);
  if (!gesture.trusted || !gesture.visible || !gesture.focused || !gesture.active) {
    notice(WORKER_QUALIFICATION_GESTURE_NOTICE);
    return undefined;
  }
  notice("");
  return connect();
}

/** Only the qualification page's Connect button uses this gate; the controller API is unchanged. */
export function bindWorkerQualificationConnect(
  maybeButton: HTMLElement | null,
  qualification: () => boolean,
  connect: () => Promise<unknown>,
  failed: () => Promise<void>,
): void {
  if (!maybeButton) return;
  let maybeNotice: HTMLParagraphElement | undefined;
  const notice = (message: string) => {
    if (!maybeNotice && message) {
      maybeNotice = document.createElement("p");
      maybeNotice.id = "qualification-connect-notice";
      maybeNotice.setAttribute("role", "status");
      maybeButton.after(maybeNotice);
    }
    if (maybeNotice) {
      maybeNotice.textContent = message;
      maybeNotice.hidden = message.length === 0;
    }
  };
  maybeButton.addEventListener("click", (event) => {
    try {
      const maybePending = maybeInvokeWorkerConnectGesture({ qualification: qualification(), trusted: event.isTrusted,
        visible: document.visibilityState === "visible", focused: document.hasFocus(), active: navigator.userActivation.isActive }, connect, notice);
      void maybePending?.catch(failed);
    } catch {
      void failed();
    }
  });
}
