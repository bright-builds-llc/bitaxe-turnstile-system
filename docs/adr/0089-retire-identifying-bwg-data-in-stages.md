# Retire identifying BWG data in stages

After protocol Retention Floors and the hosted operational window have passed, BWG records erase reusable proof material and identifying fields, retain only a context-keyed Pseudonymized Tombstone through the audit window, and then physically delete that tombstone. We rejected indefinite raw retention and immediate whole-row deletion because the former defeats identity minimization while the latter can erase bounded integrity, deduplication, and incident evidence prematurely.
