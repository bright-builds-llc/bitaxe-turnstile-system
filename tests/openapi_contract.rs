use std::collections::BTreeSet;

use serde_json::{Value, json};

#[test]
fn openapi_contract_covers_the_complete_pass_and_outcome_journey()
-> Result<(), Box<dyn std::error::Error>> {
    // Arrange
    let contract: Value = serde_json::from_str(include_str!("../openapi/bwg-0.1.json"))?;

    // Act
    let paths = contract["paths"]
        .as_object()
        .ok_or("OpenAPI paths must be an object")?
        .keys()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let schemas = contract["components"]["schemas"]
        .as_object()
        .ok_or("OpenAPI schemas must be an object")?;

    // Assert
    assert_eq!(contract["openapi"], "3.1.0");
    assert_eq!(
        paths,
        BTreeSet::from([
            "/.well-known/jwks.json",
            "/.well-known/pow-gate-configuration",
            "/account-creation/challenge",
            "/account-creation/outcomes/{action_reference}",
            "/account-creation/redeem",
            "/v0/challenges",
            "/v0/challenges/{challenge_id}/events",
            "/v0/challenges/{challenge_id}/gate-pass",
            "/v0/challenges/{challenge_id}/lifecycle",
            "/v0/challenges/{challenge_id}/pause",
            "/v0/challenges/{challenge_id}/cancel",
        ])
    );
    for schema in [
        "GatePassClaims",
        "ClaimantIssuanceProofClaims",
        "DpopClaims",
        "ClaimantOutcomeProofClaims",
        "IssuanceLookup",
        "RedemptionRecord",
        "ProtectedActionOutcome",
        "ChallengeLifecycle",
        "PauseChallengeRequest",
        "CancelChallengeRequest",
        "VerifiedProgressUpdate",
        "SignedPoolOfferSet",
        "PoolOffer",
        "RewardPolicy",
        "PayoutRequirements",
    ] {
        assert!(schemas.contains_key(schema), "missing schema {schema}");
    }
    assert_eq!(
        contract["paths"]["/v0/challenges"]["post"]["security"][0]["ServiceClientId"],
        json!([])
    );
    for path in [
        "/v0/challenges/{challenge_id}/pause",
        "/v0/challenges/{challenge_id}/cancel",
    ] {
        assert_eq!(
            contract["paths"][path]["post"]["security"][0]["ServiceClientId"],
            json!([])
        );
    }
    let sse_events =
        contract["paths"]["/v0/challenges/{challenge_id}/events"]["get"]["x-bwg-sse-events"]
            .as_object()
            .ok_or("SSE event contract must be an object")?;
    assert_eq!(
        sse_events
            .keys()
            .map(String::as_str)
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([
            "challenge_lifecycle",
            "resync_required",
            "verified_progress",
        ])
    );
    assert_eq!(
        sse_events["challenge_lifecycle"]["$ref"],
        "#/components/schemas/ChallengeLifecycle"
    );
    assert_eq!(
        schemas["ClaimantIssuanceProofClaims"]["allOf"][1]["properties"]["htm"]["const"],
        "GET"
    );
    assert!(
        schemas["WorkChallenge"]["required"]
            .as_array()
            .is_some_and(|fields| fields.iter().any(|field| field == "pool_offers"))
    );
    for schema in ["IssuanceLookup", "ProtectedActionOutcome"] {
        let variants = schemas[schema]["oneOf"]
            .as_array()
            .ok_or("state schema must use oneOf")?;
        assert!(
            variants
                .iter()
                .all(|variant| variant["additionalProperties"] == false)
        );
    }

    Ok(())
}
