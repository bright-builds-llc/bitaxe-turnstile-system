# Record Gate Pass issuance intent before asynchronous signing

The transaction that first satisfies a Work Challenge will durably create one immutable Gate Pass Issuance Intent and outbox entry alongside the accepted event, deduplication indexes, progress projection, and adapter acknowledgement. An idempotent signer processes that intent outside the accounting transaction and stores the signing result for retrieval, keeping signing-key access and delivery failures from weakening accepted-work durability or minting multiple authorizations.
