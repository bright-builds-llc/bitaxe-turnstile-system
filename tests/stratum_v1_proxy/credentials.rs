use super::*;

#[test]
fn session_credentials_are_stable_unique_and_explicitly_bounded() -> Result<(), Box<dyn Error>> {
    // Arrange
    let issuer = StratumCredentialIssuer::new(std::array::from_fn(|index| index as u8));
    let first_session = WorkSessionId::try_from("session_stratum_vector_01".to_owned())?;
    let second_session = WorkSessionId::try_from("session_stratum_vector_02".to_owned())?;

    // Act
    let first = issuer.issue(
        first_session.clone(),
        test_lease_context()?,
        1_940,
        2_000,
        3_000,
    )?;
    let repeated = issuer.issue(first_session, test_lease_context()?, 1_940, 2_000, 3_000)?;
    let second = issuer.issue(
        second_session.clone(),
        test_lease_context()?,
        1_940,
        2_000,
        3_000,
    )?;
    let unbounded = issuer.issue(second_session, test_lease_context()?, 1_000, 2_000, 3_000);
    let near_monotonic_expiry = issuer.issue(
        WorkSessionId::try_from("session_stratum_near_lease_expiry".to_owned())?,
        StratumLeaseContext::new(
            "00000000-0000-4000-8000-000000000100".to_owned(),
            "boot_near_expiry".to_owned(),
            9_500,
            9_600,
            10_500,
        )?,
        1_000,
        1_002,
        2_000,
    );

    // Assert
    assert_eq!(first, repeated);
    assert_ne!(first.username(), second.username());
    assert_ne!(first.secret(), second.secret());
    assert_eq!(first.username(), "bwg_G0DgLfAcTEhiwUOxkyauLg");
    assert_eq!(first.expires_at_unix_seconds(), 2_000);
    assert!(matches!(
        unbounded,
        Err(StratumV1Error::InvalidSessionConfig)
    ));
    assert!(matches!(
        near_monotonic_expiry,
        Err(StratumV1Error::InvalidSessionConfig)
    ));
    Ok(())
}

#[test]
fn invalid_session_credentials_fail_locally_without_reaching_upstream() -> Result<(), Box<dyn Error>>
{
    // Arrange
    let mut session = StratumSession::new(StratumSessionConfig::new(
        WorkSessionId::try_from("session_stratum_invalid_auth_01".to_owned())?,
        test_lease_context()?,
        "bwg-valid-user".to_owned(),
        "valid-session-secret".to_owned(),
        1_000,
        1_060,
        2_000,
    )?)?;
    let request =
        r#"{"id":41,"method":"mining.authorize","params":["bwg-valid-user","wrong-secret"]}"#;

    // Act
    let actions = session.worker_frame(request, 1_000)?;

    // Assert
    assert_eq!(
        actions,
        [StratumProxyAction::ForwardWorker(
            r#"{"id":41,"result":false,"error":null}"#.to_owned()
        )]
    );
    Ok(())
}

#[test]
fn expired_credentials_stop_the_connection_before_forwarding() -> Result<(), Box<dyn Error>> {
    // Arrange
    let mut session = StratumSession::new(StratumSessionConfig::new(
        WorkSessionId::try_from("session_stratum_expired_01".to_owned())?,
        test_lease_context()?,
        "bwg-expired-user".to_owned(),
        "expired-session-secret".to_owned(),
        940,
        1_000,
        2_000,
    )?)?;

    // Act
    let result = session.worker_frame(r#"{"id":1,"method":"mining.subscribe","params":[]}"#, 1_000);

    // Assert
    assert!(matches!(result, Err(StratumV1Error::ExpiredCredentials)));
    Ok(())
}
