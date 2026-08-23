# Consume every valid same-Claimant pass presented for one action

Every valid Gate Pass presented for an Action Reference is atomically consumed and linked to that action's single Redemption Record, even when another pass created the record first. Only the first accepted Redemption creates the pending outcome and Action Execution Intent; later same-action Redemptions return the existing record without restarting execution.
