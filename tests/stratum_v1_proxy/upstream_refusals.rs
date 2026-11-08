//! A pool's refusal of a submit reaches the Worker unchanged, is never persisted,
//! and carries the pool's error code so the shell can log why shares were refused.

use super::*;

fn refused_by_pool(response: &str) -> Result<Vec<StratumProxyAction>, Box<dyn Error>> {
    let mut session = prepared_submit_session(
        "session_stratum_rejected_01",
        "worker-rejected-01",
        61,
        "11121314",
        1_060,
    )?;
    Ok(session.upstream_frame(response, 1_002)?)
}

fn forwarded_refusal(maybe_code: Option<i64>, response: &str) -> Vec<StratumProxyAction> {
    vec![StratumProxyAction::ForwardUpstreamRefusal {
        maybe_code,
        worker_response: response.to_owned(),
    }]
}

#[test]
fn a_classic_array_refusal_is_forwarded_unchanged_with_its_code() -> Result<(), Box<dyn Error>> {
    // Arrange
    let rejected = r#"{"id":61,"result":false,"error":[23,"low difficulty share",null]}"#;

    // Act
    let actions = refused_by_pool(rejected)?;

    // Assert
    assert_eq!(actions, forwarded_refusal(Some(23), rejected));
    Ok(())
}

#[test]
fn an_error_object_refusal_is_forwarded_unchanged_with_its_code() -> Result<(), Box<dyn Error>> {
    // Arrange
    let rejected =
        r#"{"id":61,"result":false,"error":{"code":23,"message":"Low difficulty","data":null}}"#;

    // Act
    let actions = refused_by_pool(rejected)?;

    // Assert
    assert_eq!(actions, forwarded_refusal(Some(23), rejected));
    Ok(())
}

#[test]
fn a_refusal_without_an_error_has_no_code() -> Result<(), Box<dyn Error>> {
    // Arrange
    let rejected = r#"{"id":61,"result":false,"error":null}"#;

    // Act
    let actions = refused_by_pool(rejected)?;

    // Assert
    assert_eq!(actions, forwarded_refusal(None, rejected));
    Ok(())
}
