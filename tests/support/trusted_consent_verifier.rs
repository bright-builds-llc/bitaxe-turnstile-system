#![allow(dead_code)]

use std::{
    sync::{
        Condvar, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use bwg_core::trusted_consent::{
    TrustedConsentError, TrustedConsentWebauthnVerifier, VerifiedWebauthn, WebauthnCeremonyStart,
};
use serde_json::{Value, json};
use uuid::Uuid;

#[derive(Default)]
pub(crate) struct FakeVerifier {
    pub(crate) begin_calls: AtomicUsize,
    pub(crate) finish_calls: AtomicUsize,
}

impl TrustedConsentWebauthnVerifier for FakeVerifier {
    fn maybe_rp_origin(&self) -> Option<&str> {
        Some("https://authority.example")
    }

    fn begin(
        &self,
        _user_id: Uuid,
        _challenge_id: &str,
    ) -> Result<WebauthnCeremonyStart, TrustedConsentError> {
        self.begin_calls.fetch_add(1, Ordering::SeqCst);
        Ok(fake_ceremony_start())
    }

    fn finish(
        &self,
        response: Value,
        registration_state: Value,
    ) -> Result<VerifiedWebauthn, TrustedConsentError> {
        self.finish_calls.fetch_add(1, Ordering::SeqCst);
        std::thread::sleep(Duration::from_millis(500));
        verify_fake_credential(response, registration_state)
    }
}

#[derive(Default)]
pub(crate) struct ControlledVerifier {
    pub(crate) begin_calls: AtomicUsize,
    pub(crate) finish_calls: AtomicUsize,
    release: (Mutex<bool>, Condvar),
}

impl ControlledVerifier {
    pub(crate) fn release(&self) -> Result<(), TrustedConsentError> {
        release(&self.release)
    }
}

impl TrustedConsentWebauthnVerifier for ControlledVerifier {
    fn maybe_rp_origin(&self) -> Option<&str> {
        Some("https://authority.example")
    }

    fn begin(
        &self,
        _user_id: Uuid,
        _challenge_id: &str,
    ) -> Result<WebauthnCeremonyStart, TrustedConsentError> {
        self.begin_calls.fetch_add(1, Ordering::SeqCst);
        Ok(fake_ceremony_start())
    }

    fn finish(
        &self,
        response: Value,
        registration_state: Value,
    ) -> Result<VerifiedWebauthn, TrustedConsentError> {
        self.finish_calls.fetch_add(1, Ordering::SeqCst);
        wait_for_release(&self.release)?;
        verify_fake_credential(response, registration_state)
    }
}

#[derive(Default)]
pub(crate) struct ControlledBeginVerifier {
    pub(crate) begin_calls: AtomicUsize,
    release: (Mutex<bool>, Condvar),
}

impl ControlledBeginVerifier {
    pub(crate) fn release(&self) -> Result<(), TrustedConsentError> {
        release(&self.release)
    }
}

impl TrustedConsentWebauthnVerifier for ControlledBeginVerifier {
    fn maybe_rp_origin(&self) -> Option<&str> {
        Some("https://authority.example")
    }

    fn begin(
        &self,
        _user_id: Uuid,
        _challenge_id: &str,
    ) -> Result<WebauthnCeremonyStart, TrustedConsentError> {
        self.begin_calls.fetch_add(1, Ordering::SeqCst);
        wait_for_release(&self.release)?;
        Ok(fake_ceremony_start())
    }

    fn finish(
        &self,
        response: Value,
        registration_state: Value,
    ) -> Result<VerifiedWebauthn, TrustedConsentError> {
        verify_fake_credential(response, registration_state)
    }
}

fn release(control: &(Mutex<bool>, Condvar)) -> Result<(), TrustedConsentError> {
    let mut released = control
        .0
        .lock()
        .map_err(|_| TrustedConsentError::WebauthnUnavailable)?;
    *released = true;
    control.1.notify_all();
    Ok(())
}

fn wait_for_release(control: &(Mutex<bool>, Condvar)) -> Result<(), TrustedConsentError> {
    let mut released = control
        .0
        .lock()
        .map_err(|_| TrustedConsentError::WebauthnUnavailable)?;
    while !*released {
        released = control
            .1
            .wait(released)
            .map_err(|_| TrustedConsentError::WebauthnUnavailable)?;
    }
    Ok(())
}

fn fake_ceremony_start() -> WebauthnCeremonyStart {
    WebauthnCeremonyStart {
        creation_options: json!({ "challenge": "fake-server-challenge" }),
        registration_state: json!({ "state": "fake-server-state" }),
    }
}

fn verify_fake_credential(
    response: Value,
    registration_state: Value,
) -> Result<VerifiedWebauthn, TrustedConsentError> {
    if response != json!({ "credential": "valid" })
        || registration_state != json!({ "state": "fake-server-state" })
    {
        return Err(TrustedConsentError::WebauthnRejected);
    }
    Ok(VerifiedWebauthn {
        user_present: true,
        user_verified: true,
        attestation: "trusted_non_self",
    })
}
