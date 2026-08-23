#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { verifyLookupProof } from "../conformance/bwg-0.1/crypto-webcrypto.mjs";

const fixtureUrl = new URL(
  "../conformance/bwg-0.1/lookup-proof-vectors.json",
  import.meta.url,
);
const vectors = JSON.parse(await readFile(fixtureUrl, "utf8"));
await verifyLookupProof(
  vectors.issuance_proof.compact_jws,
  vectors.issuance_proof.type,
  "challenge_id",
);
await verifyLookupProof(
  vectors.outcome_proof.compact_jws,
  vectors.outcome_proof.type,
  "action_reference",
);
process.stdout.write(`${JSON.stringify(vectors, null, 2)}\n`);
