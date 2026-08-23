# Separate Worker Management from gating

Persistent local and remote Worker Management will be an optional bounded context connected to proof-of-work gating through a narrow Worker Controller interface. The gate remains usable through an accountless local or manually configured path, while a Device Relay may carry narrowly authorized commands and status over Worker-initiated connections without owning challenge policy, work accounting, or Gate Pass issuance.
