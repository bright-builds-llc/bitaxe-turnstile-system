# Authorize remote Workers with scoped capabilities

Remote dispatch will use an OAuth-style Worker Authorization ceremony with strong authentication, explicit Worker selection, and challenge-specific consent. Authorization-code, PKCE, and DPoP semantics yield a short-lived Worker Capability limited to one Work Challenge; the Relying Service receives no account token or Device Identity, while accountless local USB use remains independent of Worker Management.
