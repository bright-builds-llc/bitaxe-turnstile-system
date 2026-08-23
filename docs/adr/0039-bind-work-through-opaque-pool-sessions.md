# Bind work through opaque pool sessions

V1 will bind Bitcoin-productive work to a Work Challenge through unique short-lived Stratum credentials, unique extranonce space, and an authenticated one-to-one Pool Adapter mapping. It will not embed challenge identifiers in coinbases or block headers, avoiding application-data leakage and job complexity that would not remove the federated trust boundary; optional independently verifiable receipts may be designed later.
