use std::collections::BTreeSet;

use bwg_core::lifecycle::{
    ChallengeLifecycleCommand, ChallengeLifecycleState, LifecycleError, SessionLifecycleCommand,
    SessionLifecycleState, apply_challenge_command, apply_session_command, request_proof_is_fresh,
    signed_artifact_is_time_valid,
};
use serde::Deserialize;

const VECTORS: &str = include_str!("../conformance/bwg-0.1/lifecycle-vectors.json");

const CHALLENGE_STATES: [&str; 6] = [
    "issued",
    "active",
    "satisfied",
    "pass_issued",
    "cancelled",
    "expired",
];
const CHALLENGE_COMMANDS: [&str; 10] = [
    "register_session",
    "select_pool_offer",
    "confirm_pool_selection",
    "start_work",
    "accept_work",
    "pause",
    "satisfy",
    "issue_pass",
    "cancel",
    "expire",
];
const SESSION_STATES: [&str; 5] = ["ready", "leased", "stopping", "restored", "failed"];
const SESSION_COMMANDS: [&str; 5] = [
    "start_lease",
    "observe_lease",
    "stop",
    "confirm_restored",
    "fail",
];

#[derive(Deserialize)]
struct LifecycleVectors {
    profile: String,
    challenge_commands: Vec<CommandVector<ChallengeLifecycleState, ChallengeCommand>>,
    session_commands: Vec<CommandVector<SessionLifecycleState, SessionCommand>>,
    proof_freshness: Vec<FreshnessVector>,
    signed_artifact_validity: Vec<ValidityVector>,
}

#[derive(Deserialize)]
struct CommandVector<S, C> {
    from: S,
    command: C,
    expected: Expected<S>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Expected<S> {
    State { state: S },
    Refused { error: RefusalCode },
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum RefusalCode {
    ForbiddenTransition,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ChallengeCommand {
    RegisterSession,
    SelectPoolOffer,
    ConfirmPoolSelection,
    StartWork,
    AcceptWork,
    Pause,
    Satisfy,
    IssuePass,
    Cancel,
    Expire,
}

impl From<ChallengeCommand> for ChallengeLifecycleCommand {
    fn from(command: ChallengeCommand) -> Self {
        match command {
            ChallengeCommand::RegisterSession => Self::RegisterSession,
            ChallengeCommand::SelectPoolOffer => Self::SelectPoolOffer,
            ChallengeCommand::ConfirmPoolSelection => Self::ConfirmPoolSelection,
            ChallengeCommand::StartWork => Self::StartWork,
            ChallengeCommand::AcceptWork => Self::AcceptWork,
            ChallengeCommand::Pause => Self::Pause,
            ChallengeCommand::Satisfy => Self::Satisfy,
            ChallengeCommand::IssuePass => Self::IssuePass,
            ChallengeCommand::Cancel => Self::Cancel,
            ChallengeCommand::Expire => Self::Expire,
        }
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum SessionCommand {
    StartLease,
    ObserveLease,
    Stop,
    ConfirmRestored,
    Fail,
}

impl From<SessionCommand> for SessionLifecycleCommand {
    fn from(command: SessionCommand) -> Self {
        match command {
            SessionCommand::StartLease => Self::StartLease,
            SessionCommand::ObserveLease => Self::ObserveLease,
            SessionCommand::Stop => Self::Stop,
            SessionCommand::ConfirmRestored => Self::ConfirmRestored,
            SessionCommand::Fail => Self::Fail,
        }
    }
}

#[derive(Deserialize)]
struct FreshnessVector {
    id: String,
    now: u64,
    issued_at: u64,
    freshness_seconds: u64,
    fresh: bool,
}

#[derive(Deserialize)]
struct ValidityVector {
    id: String,
    now: u64,
    issued_at: u64,
    expires_at: u64,
    valid: bool,
}

#[derive(Deserialize)]
struct RawCase {
    from: String,
    command: String,
}

#[derive(Deserialize)]
struct RawVectors {
    challenge_commands: Vec<RawCase>,
    session_commands: Vec<RawCase>,
}

fn vectors() -> Result<LifecycleVectors, serde_json::Error> {
    serde_json::from_str(VECTORS)
}

fn refusal(error: LifecycleError) -> Option<RefusalCode> {
    match error {
        LifecycleError::ForbiddenTransition => Some(RefusalCode::ForbiddenTransition),
        _ => None,
    }
}

fn case_pairs(cases: &[RawCase]) -> Vec<(String, String)> {
    cases
        .iter()
        .map(|case| (case.from.clone(), case.command.clone()))
        .collect()
}

fn every_pair(states: &[&str], commands: &[&str]) -> BTreeSet<(String, String)> {
    states
        .iter()
        .flat_map(|state| {
            commands
                .iter()
                .map(move |command| (state.to_string(), command.to_string()))
        })
        .collect()
}

#[test]
fn lifecycle_vectors_name_the_bwg_0_1_profile() -> Result<(), serde_json::Error> {
    // Act
    let vectors = vectors()?;

    // Assert
    assert_eq!(vectors.profile, "BWG/0.1");
    Ok(())
}

#[test]
fn challenge_vectors_name_every_state_and_command_once() -> Result<(), serde_json::Error> {
    // Arrange
    let raw: RawVectors = serde_json::from_str(VECTORS)?;

    // Act
    let pairs = case_pairs(&raw.challenge_commands);

    // Assert
    let unique: BTreeSet<_> = pairs.iter().cloned().collect();
    assert_eq!(unique.len(), pairs.len(), "a challenge case repeats");
    assert_eq!(unique, every_pair(&CHALLENGE_STATES, &CHALLENGE_COMMANDS));
    Ok(())
}

#[test]
fn session_vectors_name_every_state_and_command_once() -> Result<(), serde_json::Error> {
    // Arrange
    let raw: RawVectors = serde_json::from_str(VECTORS)?;

    // Act
    let pairs = case_pairs(&raw.session_commands);

    // Assert
    let unique: BTreeSet<_> = pairs.iter().cloned().collect();
    assert_eq!(unique.len(), pairs.len(), "a session case repeats");
    assert_eq!(unique, every_pair(&SESSION_STATES, &SESSION_COMMANDS));
    Ok(())
}

#[test]
fn challenge_commands_follow_the_vectors() -> Result<(), serde_json::Error> {
    // Arrange
    let vectors = vectors()?;

    for vector in vectors.challenge_commands {
        // Act
        let result = apply_challenge_command(vector.from, vector.command.into());

        // Assert
        match vector.expected {
            Expected::State { state } => assert_eq!(result, Ok(state), "{:?}", vector.from),
            Expected::Refused { error } => {
                assert_eq!(
                    result.map_err(refusal),
                    Err(Some(error)),
                    "{:?}",
                    vector.from
                )
            }
        }
    }
    Ok(())
}

#[test]
fn session_commands_follow_the_vectors() -> Result<(), serde_json::Error> {
    // Arrange
    let vectors = vectors()?;

    for vector in vectors.session_commands {
        // Act
        let result = apply_session_command(vector.from, vector.command.into());

        // Assert
        match vector.expected {
            Expected::State { state } => assert_eq!(result, Ok(state), "{:?}", vector.from),
            Expected::Refused { error } => {
                assert_eq!(
                    result.map_err(refusal),
                    Err(Some(error)),
                    "{:?}",
                    vector.from
                )
            }
        }
    }
    Ok(())
}

#[test]
fn proof_freshness_follows_the_vectors() -> Result<(), serde_json::Error> {
    // Arrange
    let vectors = vectors()?;

    for vector in vectors.proof_freshness {
        // Act
        let fresh = request_proof_is_fresh(vector.now, vector.issued_at, vector.freshness_seconds);

        // Assert
        assert_eq!(fresh, vector.fresh, "{}", vector.id);
    }
    Ok(())
}

#[test]
fn signed_artifact_validity_follows_the_vectors() -> Result<(), serde_json::Error> {
    // Arrange
    let vectors = vectors()?;

    for vector in vectors.signed_artifact_validity {
        // Act
        let valid = signed_artifact_is_time_valid(vector.now, vector.issued_at, vector.expires_at);

        // Assert
        assert_eq!(valid, vector.valid, "{}", vector.id);
    }
    Ok(())
}
