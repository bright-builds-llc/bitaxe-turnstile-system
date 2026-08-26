use super::*;

#[test]
fn subminimum_fractional_difficulty_saturates_at_the_uint256_target() -> Result<(), Box<dyn Error>>
{
    // Arrange
    let mut session = authorized_session()?;
    session.upstream_frame(
        r#"{"id":null,"method":"mining.set_difficulty","params":[0.0000000001]}"#,
        1_000,
    )?;
    session.upstream_frame(
        r#"{"id":null,"method":"mining.notify","params":["job-target-saturation","0000000000000000000000000000000000000000000000000000000000000000","01000000","00",[],"20000000","207fffff","5f5e1000",true]}"#,
        1_000,
    )?;
    session.worker_frame(
        r#"{"id":9,"method":"mining.submit","params":["bwg-session-stale","job-target-saturation","00000001","5f5e1000","00000000"]}"#,
        1_001,
    )?;

    // Act
    let actions = session.upstream_frame(r#"{"id":9,"result":true,"error":null}"#, 1_002)?;

    // Assert
    let [StratumProxyAction::PersistAccepted { event, .. }] = actions.as_slice() else {
        return Err("accepted result must request persistence".into());
    };
    assert_eq!(event.assigned_target_be_bytes(), [u8::MAX; 32]);
    Ok(())
}

#[test]
fn hydra_scaled_vardiff_targets_saturate_only_when_the_final_value_overflows()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let cases = [
        ("0.0000000002", [u8::MAX; 32]),
        (
            "0.0000000003",
            hex_target("c6addaa6b4000000000000000000000000000000000000000000000000000000")?,
        ),
        (
            "0.0000000004",
            hex_target("950263fd07000000000000000000000000000000000000000000000000000000")?,
        ),
    ];

    // Act and Assert
    for (difficulty, expected_target) in cases {
        assert_eq!(
            accepted_target(difficulty, expected_target)?,
            expected_target
        );
    }
    Ok(())
}

#[test]
fn upstream_success_below_the_assigned_target_fails_without_persistence_or_worker_ack()
-> Result<(), Box<dyn Error>> {
    // Arrange
    let mut session = authorized_session()?;
    session.upstream_frame(
        r#"{"id":null,"method":"mining.set_difficulty","params":[1000000000000000000]}"#,
        1_000,
    )?;
    session.upstream_frame(
        r#"{"id":null,"method":"mining.notify","params":["job-below-target","0000000000000000000000000000000000000000000000000000000000000000","01000000","00",[],"20000000","207fffff","5f5e1000",true]}"#,
        1_000,
    )?;
    let submit = session.worker_frame(
        r#"{"id":12,"method":"mining.submit","params":["bwg-session-stale","job-below-target","00000001","5f5e1000","00000000"]}"#,
        1_001,
    )?;

    // Act
    let result = session.upstream_frame(r#"{"id":12,"result":true,"error":null}"#, 1_002);

    // Assert
    assert!(matches!(
        submit.as_slice(),
        [StratumProxyAction::ForwardUpstream(_)]
    ));
    assert!(matches!(
        result,
        Err(StratumV1Error::ShareBelowAssignedTarget)
    ));
    Ok(())
}

#[test]
fn fractional_difficulty_uses_exact_decimal_target_arithmetic() -> Result<(), Box<dyn Error>> {
    // Arrange
    let mut session = authorized_session()?;
    session.upstream_frame(
        r#"{"id":null,"method":"mining.set_difficulty","params":[0.000000001]}"#,
        1_000,
    )?;
    session.upstream_frame(
        r#"{"id":null,"method":"mining.notify","params":["job-diff-half","0000000000000000000000000000000000000000000000000000000000000000","01000000","00",[],"20000000","1d00ffff","5f5e1000",true]}"#,
        1_000,
    )?;
    let nonce = worked_nonce(
        "01020304",
        "00000001",
        StratumJobFields::new(
            "0000000000000000000000000000000000000000000000000000000000000000",
            "01000000",
            "00",
            "20000000",
            "1d00ffff",
            "5f5e1000",
        ),
        hex_target("3b9a8e6536000000000000000000000000000000000000000000000000000000")?,
    )?;
    session.worker_frame(
        &format!(r#"{{"id":10,"method":"mining.submit","params":["bwg-session-stale","job-diff-half","00000001","5f5e1000","{nonce}"]}}"#),
        1_001,
    )?;

    // Act
    let actions = session.upstream_frame(r#"{"id":10,"result":true,"error":null}"#, 1_002)?;

    // Assert
    let [StratumProxyAction::PersistAccepted { event, .. }] = actions.as_slice() else {
        return Err("accepted result must request persistence".into());
    };
    assert_eq!(
        event.assigned_target_be_bytes(),
        hex_target("3b9a8e6536000000000000000000000000000000000000000000000000000000")?
    );
    Ok(())
}

#[test]
fn worked_candidate_is_classified_against_the_network_target() -> Result<(), Box<dyn Error>> {
    // Arrange
    let mut session = StratumSession::new(StratumSessionConfig::new(
        WorkSessionId::try_from("session_stratum_network_target_01".to_owned())?,
        test_lease_context()?,
        "bwg-network-target".to_owned(),
        "network-target-secret".to_owned(),
        1_000,
        1_060,
        2_000,
    )?)?;
    session.worker_frame(
        r#"{"id":1,"method":"mining.authorize","params":["bwg-network-target","network-target-secret"]}"#,
        1_000,
    )?;
    session.upstream_frame(r#"{"id":1,"result":true,"error":null}"#, 1_000)?;
    session.worker_frame(r#"{"id":2,"method":"mining.subscribe","params":[]}"#, 1_000)?;
    let subscribe_actions = session.upstream_frame(
        r#"{"id":2,"result":[[["mining.notify","network-target"]],"01020304",4],"error":null}"#,
        1_000,
    )?;
    let [StratumProxyAction::ReserveExtranonce { token, .. }] = subscribe_actions.as_slice() else {
        return Err("network target vector needs extranonce reservation".into());
    };
    let _ = session.extranonce_reserved(token)?;
    session.upstream_frame(
        r#"{"id":null,"method":"mining.set_difficulty","params":[0.000000001]}"#,
        1_000,
    )?;
    session.upstream_frame(
        r#"{"id":null,"method":"mining.notify","params":["job-network-target","0000000000000000000000000000000000000000000000000000000000000000","01000000","00",[],"20000000","207fffff","5f5e1000",true]}"#,
        1_000,
    )?;
    let nonce = worked_nonce(
        "01020304",
        "00000001",
        StratumJobFields::new(
            "0000000000000000000000000000000000000000000000000000000000000000",
            "01000000",
            "00",
            "20000000",
            "207fffff",
            "5f5e1000",
        ),
        hex_target("3b9a8e6536000000000000000000000000000000000000000000000000000000")?,
    )?;
    session.worker_frame(
        &format!(r#"{{"id":3,"method":"mining.submit","params":["bwg-network-target","job-network-target","00000001","5f5e1000","{nonce}"]}}"#),
        1_001,
    )?;

    // Act
    let actions = session.upstream_frame(r#"{"id":3,"result":true,"error":null}"#, 1_002)?;

    // Assert
    let [StratumProxyAction::PersistAccepted { event, .. }] = actions.as_slice() else {
        return Err("network target result must request persistence".into());
    };
    assert_eq!(
        event.network_target_outcome(),
        NetworkTargetOutcome::NetworkTargetMet
    );
    Ok(())
}

fn accepted_target(
    difficulty: &str,
    expected_target: [u8; 32],
) -> Result<[u8; 32], Box<dyn Error>> {
    let mut session = authorized_session()?;
    session.upstream_frame(
        &format!(r#"{{"id":null,"method":"mining.set_difficulty","params":[{difficulty}]}}"#),
        1_000,
    )?;
    session.upstream_frame(
        r#"{"id":null,"method":"mining.notify","params":["job-tiny-vardiff","0000000000000000000000000000000000000000000000000000000000000000","01000000","00",[],"20000000","207fffff","5f5e1000",true]}"#,
        1_000,
    )?;
    let nonce = worked_nonce(
        "01020304",
        "00000001",
        StratumJobFields::new(
            "0000000000000000000000000000000000000000000000000000000000000000",
            "01000000",
            "00",
            "20000000",
            "207fffff",
            "5f5e1000",
        ),
        expected_target,
    )?;
    session.worker_frame(
        &format!(r#"{{"id":11,"method":"mining.submit","params":["bwg-session-stale","job-tiny-vardiff","00000001","5f5e1000","{nonce}"]}}"#),
        1_001,
    )?;
    let actions = session.upstream_frame(r#"{"id":11,"result":true,"error":null}"#, 1_002)?;
    let [StratumProxyAction::PersistAccepted { event, .. }] = actions.as_slice() else {
        return Err("accepted result must request persistence".into());
    };
    Ok(event.assigned_target_be_bytes())
}
