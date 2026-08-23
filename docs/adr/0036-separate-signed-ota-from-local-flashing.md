# Separate signed remote OTA from local owner flashing

Remote OTA will accept only board-compatible manifests and images signed by the configured, replaceable Update Authority, with signing isolated from ordinary deployment credentials and rollback preserving a bootable partition, settings, and Device Identity. Local USB recovery remains owner-controlled and may install another image after informed confirmation, so compromise of the Device Relay cannot authorize firmware and Bright Builds cannot permanently lock open hardware.
