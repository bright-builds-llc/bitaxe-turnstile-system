#!/usr/bin/env bun
/**
 * Joins Hydra's Job Admission log with the Pool Adapter's relayed jobs, so a run shows that every
 * job a Worker received had passed the Reward Policy and BIP 23 proposal first (criterion 5).
 *
 * Usage: bun scripts/job-admission-evidence.ts --adapter-log FILE --hydra-log FILE [--hydra-log FILE…]
 *   Each Hydra start writes its own `hydra-<run>.log`; pass every one from the run. Prints counts
 *   and relay times only, never job IDs or candidate digests, and exits 1 unless at least one job
 *   was relayed and every relayed job had an accepted admission.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

/** What one run's two logs show. Counts are of distinct jobs, except `failedAdmissions`, which counts lines. */
export interface JobAdmissionReport {
  relayed: number;
  admitted: number;
  failedAdmissions: number;
  admittedNotRelayed: number;
  unadmittedRelayed: number;
  maybeFirstRelayedAt: string | undefined;
  maybeLastRelayedAt: string | undefined;
  passed: boolean;
}

// tracing_subscriber::fmt colours its output even into a file.
const ANSI_ESCAPE = /\u001b\[[0-9;]*m/g;
const JOB_ID = /\bjob_id=(\S+)/;

/** Pure join of one run's log lines; Hydra logs job IDs in decimal and the adapter relays them in hex. */
export function joinJobAdmissions(input: { hydraLines: string[]; adapterLines: string[] }): JobAdmissionReport {
  const admitted = new Set<string>();
  let failedAdmissions = 0;
  for (const line of input.hydraLines.map(plain)) {
    if (line.includes(" Job admission failed")) failedAdmissions += 1;
    if (!line.includes(" Job admission completed")) continue;
    const maybeId = jobKey(line, 10);
    if (maybeId !== undefined) admitted.add(maybeId);
  }

  const relayed = new Set<string>();
  const relayTimes: string[] = [];
  for (const line of input.adapterLines.map(plain)) {
    if (!line.includes(" Stratum job relayed")) continue;
    relayTimes.push(line.split(" ", 1)[0] ?? "");
    const rawId = JOB_ID.exec(line)?.[1] ?? "";
    relayed.add(jobKey(line, 16) ?? `unparsed:${rawId}`);
  }

  const unadmittedRelayed = [...relayed].filter((id) => !admitted.has(id)).length;
  return {
    relayed: relayed.size,
    admitted: admitted.size,
    failedAdmissions,
    admittedNotRelayed: [...admitted].filter((id) => !relayed.has(id)).length,
    unadmittedRelayed,
    maybeFirstRelayedAt: relayTimes[0],
    maybeLastRelayedAt: relayTimes.at(-1),
    passed: relayed.size > 0 && unadmittedRelayed === 0,
  };
}

function plain(line: string): string {
  return line.replace(ANSI_ESCAPE, "");
}

/** The job ID as a canonical decimal string; IDs exceed 2^53, so they're parsed as BigInt. */
function jobKey(line: string, radix: 10 | 16): string | undefined {
  const maybeRaw = JOB_ID.exec(line)?.[1];
  if (maybeRaw === undefined) return undefined;
  const digits = radix === 16 ? /^[0-9a-f]+$/i : /^[0-9]+$/;
  if (!digits.test(maybeRaw)) return undefined;
  return BigInt(radix === 16 ? `0x${maybeRaw}` : maybeRaw).toString();
}

async function lines(path: string): Promise<string[]> {
  return (await readFile(path, "utf8")).split("\n");
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { "adapter-log": { type: "string" }, "hydra-log": { type: "string", multiple: true } },
  });
  const maybeAdapterLog = values["adapter-log"];
  const hydraLogs = values["hydra-log"] ?? [];
  if (maybeAdapterLog === undefined || hydraLogs.length === 0) {
    console.error("usage: job-admission-evidence.ts --adapter-log FILE --hydra-log FILE [--hydra-log FILE…]");
    process.exit(2);
  }
  const hydraLines = (await Promise.all(hydraLogs.map(lines))).flat();
  const report = joinJobAdmissions({ hydraLines, adapterLines: await lines(maybeAdapterLog) });
  console.log(JSON.stringify(report));
  process.exitCode = report.passed ? 0 : 1;
}
