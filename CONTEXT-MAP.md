# Bitcoin Work Gate Context Map

## Contexts

- [Proof-of-Work Gating](./docs/contexts/proof-of-work-gating/CONTEXT.md) — prices and authorizes protected actions using Bitcoin-productive work
- [Worker Management](./docs/contexts/worker-management/CONTEXT.md) — optionally controls and observes Workers locally or remotely
- [Identity and Access](./docs/contexts/identity-and-access/CONTEXT.md) — manages passwordless account identities and their authenticators
- [Digital Energy Credits](./docs/contexts/digital-energy-credits/CONTEXT.md) — deferred v2 accounting for previously verified Bitcoin-productive work

## Relationships

- **Proof-of-Work Gating → Worker Management**: A Reference Client asks a Worker Controller to start, observe, cancel, and restore challenge-scoped work.
- **Worker Management → Proof-of-Work Gating**: Worker Management transports authorized commands and status but does not own Work Challenge policy, Credited Work accounting, or Gate Pass issuance.
- **Proof-of-Work Gating → Identity and Access**: Account creation may be a Protected Action, but an anonymous Claimant can complete a gate without an Account Identity.
- **Identity and Access → Worker Management**: Account Identities receive Control Grants for Device Identities; authenticators and device keys remain distinct.
- **Proof-of-Work Gating → Digital Energy Credits**: A future, separately consented credit-issuance action may convert verified work into credits; v1 action-bound Gate Passes never become credits automatically.
- **Identity and Access → Digital Energy Credits**: Future Digital Energy Credits are account-bound records rather than bearer instruments.
