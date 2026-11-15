/**
 * Binds the onboarding sitting (`bitaxe-onboarding-sitting.ts`) to `sitting.html`. Private inputs
 * arrive only through the page's file pickers; nothing is fetched or sent anywhere.
 * `window.bitaxeOnboardingSitting.state()` gives DevTools the same redacted state the page shows.
 */
import {
  createOnboardingSitting,
  firmwarePackageFromFiles,
  parseSittingConfiguration,
  type OnboardingSitting,
  type SittingConfiguration,
  type SittingState,
  type SittingStatus,
} from "./bitaxe-onboarding-sitting";
import type { FirmwarePackage } from "./bitaxe-onboarding";

declare const BWG_GATE_SOURCE_COMMIT: string;
const gateCommit = typeof BWG_GATE_SOURCE_COMMIT === "string" ? BWG_GATE_SOURCE_COMMIT : "Unavailable";

const PACKAGE_INPUTS = ["signed-manifest", "image", "bootloader", "partition-table"] as const;
/** Which control each status allows. */
const ENABLED_IN: Record<string, readonly SittingStatus[]> = {
  connect: ["configured"],
  install: ["inspected"],
  stop: ["inspected"],
  keep: ["installed"],
  "roll-back": ["installed"],
};

type PageState = {
  gateCommit: string;
  files: { configuration: boolean; package: boolean };
  setupError?: string;
  sitting?: SittingState;
};

let maybeConfiguration: SittingConfiguration | undefined;
let maybePackage: FirmwarePackage | undefined;
let maybeSitting: OnboardingSitting | undefined;
let maybeSetupError: string | undefined;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`the page has no #${id}`);
  return found as T;
}

function pageState(): PageState {
  return {
    gateCommit,
    files: { configuration: maybeConfiguration !== undefined, package: maybePackage !== undefined },
    ...(maybeSetupError ? { setupError: maybeSetupError } : {}),
    ...(maybeSitting ? { sitting: maybeSitting.state() } : {}),
  };
}

function publish(): void {
  const state = pageState();
  const status = state.sitting?.status;
  element("status").textContent = state.setupError ?? (status ? `Sitting: ${status}` : "Load the configuration and the four package files.");
  element("state").textContent = JSON.stringify(state, null, 2);
  for (const [id, statuses] of Object.entries(ENABLED_IN)) {
    element<HTMLButtonElement>(id).disabled = !status || !statuses.includes(status);
  }
  for (const id of ["configuration", ...PACKAGE_INPUTS]) {
    element<HTMLInputElement>(id).disabled = maybeSitting !== undefined && status !== "configured";
  }
}

function selectedFile(id: string): File | undefined {
  return element<HTMLInputElement>(id).files?.[0];
}

async function bytes(id: string): Promise<Uint8Array | undefined> {
  const file = selectedFile(id);
  return file ? new Uint8Array(await file.arrayBuffer()) : undefined;
}

/** Re-reads the pickers and, once all five files are in, builds a fresh sitting. */
async function loadFiles(): Promise<void> {
  maybeSetupError = undefined;
  try {
    const configurationFile = selectedFile("configuration");
    maybeConfiguration = configurationFile ? parseSittingConfiguration(await configurationFile.text()) : undefined;
    const manifestFile = selectedFile("signed-manifest");
    const [image, bootloader, partitionTable] = await Promise.all([bytes("image"), bytes("bootloader"), bytes("partition-table")]);
    maybePackage = manifestFile && image && bootloader && partitionTable
      ? firmwarePackageFromFiles({ signedManifest: await manifestFile.text(), image, bootloader, partitionTable })
      : undefined;
  } catch (error) {
    maybeSetupError = error instanceof Error ? error.message : String(error);
  }
  maybeSitting = maybeConfiguration && maybePackage
    ? createOnboardingSitting({
        configuration: maybeConfiguration,
        firmwarePackage: maybePackage,
        maybeDownloadMigrationBackup: downloadMigrationBackup,
      })
    : undefined;
  publish();
}

/** Saves the encrypted Migration Backup through a download link. */
async function downloadMigrationBackup(encryptedBackup: Uint8Array): Promise<void> {
  const url = URL.createObjectURL(new Blob([encryptedBackup.slice()], { type: "application/octet-stream" }));
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = `bitaxe-${maybeConfiguration?.board ?? "board"}-migration-backup.bin`;
    link.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

/** Runs one owner action, publishing as it goes and once it rests. */
function bind(id: string, run: (sitting: OnboardingSitting) => Promise<void>): void {
  element(id).addEventListener("click", () => {
    const sitting = maybeSitting;
    if (!sitting) return;
    const running = run(sitting);
    publish();
    const ticker = setInterval(publish, 500);
    running.catch((error: unknown) => {
      maybeSetupError = error instanceof Error ? error.message : String(error);
    }).finally(() => {
      clearInterval(ticker);
      publish();
    });
  });
}

for (const id of ["configuration", ...PACKAGE_INPUTS]) {
  element(id).addEventListener("change", () => void loadFiles());
}
bind("connect", (sitting) => sitting.connect());
bind("install", (sitting) => {
  const passphrase = element<HTMLInputElement>("passphrase").value;
  return sitting.install(passphrase === "" ? {} : { maybeBackupPassphrase: passphrase });
});
bind("stop", (sitting) => sitting.stopBeforeInstall());
bind("keep", (sitting) => sitting.keep());
bind("roll-back", (sitting) => sitting.rollBack());

Object.assign(window, { bitaxeOnboardingSitting: { state: pageState } });
publish();
