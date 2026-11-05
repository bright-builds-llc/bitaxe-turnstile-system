use serde_json::Value;

use super::*;

const VECTORS: &str =
    include_str!("../../conformance/bwg-worker-deployment-trust-0.2/authority-signer-vectors.json");

fn vectors() -> Value {
    serde_json::from_str(VECTORS).expect("committed vectors are JSON")
}

fn text(value: &Value) -> String {
    value.as_str().expect("vector field is a string").to_owned()
}

fn vector_signer(vectors: &Value) -> WorkLeaseAuthoritySigner {
    WorkLeaseAuthoritySigner::from_seed_base64url(
        text(&vectors["trust"]["keys"][0]["kid"]),
        text(&vectors["trust"]["issuer"]),
        &text(&vectors["seedBase64Url"]),
    )
    .expect("vector seed imports")
}

fn vector_case<'a>(vectors: &'a Value, name: &str) -> &'a Value {
    vectors["cases"]
        .as_array()
        .expect("cases are an array")
        .iter()
        .find(|case| case["name"] == name)
        .expect("vector case exists")
}

fn control_session(case: &Value) -> ControlSessionBinding {
    ControlSessionBinding::try_from(text(&case["input"]["controlSessionBindingSha256"]))
        .expect("vector digest is valid")
}

fn sequence(case: &Value) -> AuthorizationSequence {
    let value = text(&case["sequence"])
        .parse::<u64>()
        .expect("vector sequence is decimal");
    AuthorizationSequence::try_from(value).expect("vector sequence is non-zero")
}

#[test]
fn start_grant_matches_the_typescript_signer_bytes() {
    // Arrange
    let vectors = vectors();
    let case = vector_case(&vectors, "start");
    let request = &case["input"]["request"];
    let stratum = WorkerStratumV1::new(
        text(&request["stratum"]["endpoint"]),
        text(&request["stratum"]["username"]),
        text(&request["stratum"]["password"]),
    )
    .expect("vector Stratum fields are valid");

    // Act
    let grant = vector_signer(&vectors)
        .sign_grant(
            text(&request["leaseId"]),
            text(&request["challengeId"]),
            stratum,
            &control_session(case),
            sequence(case),
        )
        .expect("vector grant signs");

    // Assert
    assert_eq!(grant.authorization(), case["authorization"]);
}

#[test]
fn renewal_at_the_allocator_ceiling_matches_the_typescript_signer_bytes() {
    // Arrange
    let vectors = vectors();
    let case = vector_case(&vectors, "renew_at_allocator_ceiling");

    // Act
    let renewal = vector_signer(&vectors)
        .sign_renewal(
            text(&case["input"]["request"]["leaseId"]),
            &text(&case["input"]["activeChallengeId"]),
            &control_session(case),
            sequence(case),
        )
        .expect("vector renewal signs");

    // Assert
    assert_eq!(renewal.authorization(), case["authorization"]);
}

#[test]
fn grant_serializes_the_controller_wire_shape() {
    // Arrange
    let vectors = vectors();
    let case = vector_case(&vectors, "start");
    let request = &case["input"]["request"];
    let stratum = WorkerStratumV1::new(
        text(&request["stratum"]["endpoint"]),
        text(&request["stratum"]["username"]),
        text(&request["stratum"]["password"]),
    )
    .expect("vector Stratum fields are valid");
    let grant = vector_signer(&vectors)
        .sign_grant(
            text(&request["leaseId"]),
            text(&request["challengeId"]),
            stratum,
            &control_session(case),
            sequence(case),
        )
        .expect("vector grant signs");

    // Act
    let mut wire = serde_json::to_value(&grant).expect("grant serializes");
    let authorization = wire
        .as_object_mut()
        .expect("grant is an object")
        .remove("authorization");

    // Assert
    assert_eq!(&wire, request);
    assert_eq!(authorization, Some(case["authorization"].clone()));
}

#[test]
fn zero_sequence_is_rejected() {
    // Act
    let result = AuthorizationSequence::try_from(0);

    // Assert
    assert_eq!(result, Err(WorkLeaseAuthorizationError::InvalidSequence));
}

#[test]
fn short_control_session_digest_is_rejected() {
    // Act
    let result = ControlSessionBinding::try_from("too-short".to_owned());

    // Assert
    assert_eq!(
        result,
        Err(WorkLeaseAuthorizationError::InvalidControlSessionBinding)
    );
}

#[test]
fn stratum_endpoint_with_user_info_is_rejected() {
    // Act
    let result = WorkerStratumV1::new(
        "stratum+tcp://user@pool-adapter.test:3333/".to_owned(),
        "bwg_user".to_owned(),
        "secret".to_owned(),
    );

    // Assert
    assert_eq!(result, Err(WorkLeaseAuthorizationError::InvalidStratum));
}

#[test]
fn stratum_endpoint_without_a_port_is_rejected() {
    // Act
    let valid = valid_stratum_endpoint("stratum+tcp://pool-adapter.test/");

    // Assert
    assert!(!valid);
}

#[test]
fn issuer_label_with_a_url_is_rejected() {
    // Arrange
    let vectors = vectors();

    // Act
    let result = WorkLeaseAuthoritySigner::from_seed_base64url(
        "test-work-lease-authority".to_owned(),
        "https://authority.example".to_owned(),
        &text(&vectors["seedBase64Url"]),
    );

    // Assert
    assert!(matches!(
        result,
        Err(WorkLeaseAuthorizationError::InvalidIssuer)
    ));
}
