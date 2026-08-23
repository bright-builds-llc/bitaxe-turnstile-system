# Keep block submission off the gate path

The Mining Pool will submit every network-valid block candidate immediately through its own latency-critical Bitcoin-node path, without waiting for Pool Adapter delivery, Gate Authority accounting, or application state. Gate progress credits only the assigned share target, completion does not wait for block acceptance, and stale or reorganized reward outcomes do not revoke a Gate Pass because the underlying work was still performed.
