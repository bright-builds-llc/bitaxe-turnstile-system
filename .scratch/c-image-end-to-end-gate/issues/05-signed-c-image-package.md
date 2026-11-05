# Owner signs the C image's firmware package

Type: task
Status: ready-for-human
Blocked by: 03, 04

## Objective

Onboarding installs only a package whose `bwg-firmware-manifest+jws` the Update
Authority signed. Only the owner signs it. Agents prepare the unsigned manifest
and check the signed one; they never handle the owner's keys.

## Plan

- [ ] Agent: build the reference image from a pushed C-repository commit with the
  owner's public trust, and record its commit, image and ELF digests.
- [ ] Agent: prepare the unsigned manifest (version, image digest, boards 205 and
  601, partition and rollback, settings schemas, public HTTPS source).
- [ ] Owner: review the GPL source and notice obligations before distributing the
  image, as the C repository's owner decisions require.
- [ ] Owner: sign the manifest, and new capabilities if Ticket 03 changed the
  Worker Serial manifest.
- [ ] Agent: verify the signed manifest against the owner's public trust with the
  Gate's package admission.

## Comments
