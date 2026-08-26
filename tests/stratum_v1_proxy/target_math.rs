use super::*;

#[test]
fn fractional_difficulty_uses_exact_decimal_target_arithmetic() -> Result<(), Box<dyn Error>> {
    // Arrange
    let mut session = authorized_session()?;
    session.upstream_frame(
        r#"{"id":null,"method":"mining.set_difficulty","params":[0.5]}"#,
        1_000,
    )?;
    session.upstream_frame(
        r#"{"id":null,"method":"mining.notify","params":["job-diff-half","0000000000000000000000000000000000000000000000000000000000000000","01000000","00",[],"20000000","1d00ffff","5f5e1000",true]}"#,
        1_000,
    )?;
    session.worker_frame(
        r#"{"id":10,"method":"mining.submit","params":["bwg-session-stale","job-diff-half","00000001","5f5e1000","abcdef01"]}"#,
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
        hex_target("00000001fffe0000000000000000000000000000000000000000000000000000")?
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
    session.worker_frame(
        r#"{"id":3,"method":"mining.submit","params":["bwg-network-target","job-network-target","00000001","5f5e1000","00000003"]}"#,
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
