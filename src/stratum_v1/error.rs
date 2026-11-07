use thiserror::Error;

#[derive(Debug, Error)]
pub enum StratumV1Error {
    #[error("Stratum Session configuration is invalid")]
    InvalidSessionConfig,
    #[error("Stratum V1 frame is invalid")]
    InvalidFrame,
    #[error("Stratum Session credentials are invalid")]
    InvalidCredentials,
    #[error("Stratum Session credentials expired")]
    ExpiredCredentials,
    #[error("Stratum authorization is required before submission")]
    AuthorizationRequired,
    #[error("Stratum assigned target is unavailable")]
    TargetRequired,
    #[error("Stratum difficulty is unsupported")]
    UnsupportedDifficulty,
    #[error("Stratum extranonce is invalid")]
    InvalidExtranonce,
    #[error("Stratum extranonce space is already assigned to another Work Session")]
    ExtranonceCollision,
    #[error("Stratum submission rolls the version without a negotiated version mask")]
    VersionRollingNotNegotiated,
    #[error("accepted submission persistence token is unknown")]
    UnknownPersistenceToken,
    #[error("Stratum extranonce reservation token is unknown")]
    UnknownExtranonceToken,
    #[error("Stratum JSON-RPC request identity is already outstanding")]
    DuplicateRequestId,
    #[error("Stratum V1 frame exceeds the configured size limit")]
    FrameTooLarge,
    #[error("Stratum Session state exceeds the configured capacity")]
    CapacityExceeded,
    #[error("upstream accepted a share below the assigned Stratum target")]
    ShareBelowAssignedTarget,
    #[error("accepted-work outbox replay conflicts with its durable event")]
    ConflictingOutboxReplay,
    #[error("Stratum Session replay conflicts with its durable credentials")]
    ConflictingSessionReplay,
    #[error("Stratum Session is not registered")]
    UnknownSession,
    #[error("Stratum Session cannot be extended under this lease")]
    UnextendableSession,
    #[error("accepted-work delivery lease is no longer owned by this worker")]
    LostDeliveryLease,
    #[error("Pool Adapter database operation failed")]
    Database(#[from] sqlx::Error),
    #[error("Pool Adapter migration failed")]
    Migration(#[from] sqlx::migrate::MigrateError),
    #[error("Stratum V1 transport failed")]
    Io(#[from] std::io::Error),
    #[error("Pool Adapter clock is unavailable")]
    Clock(#[from] std::time::SystemTimeError),
    #[error("Pool Adapter wall clock moved backwards during a Stratum Session")]
    ClockRollback,
    #[error("Pool Adapter retention policy is below the hosted safety floor")]
    InvalidRetentionPolicy,
    #[error(
        "Stratum admission failed ({admission}) and reservation cleanup also failed ({cleanup})"
    )]
    AdmissionCleanup {
        admission: Box<StratumV1Error>,
        cleanup: Box<StratumV1Error>,
    },
    #[error("authenticated Work Session disconnect could not be delivered to the Gate Authority")]
    DisconnectNotificationUnavailable,
    #[error("Stratum transport ended ({transport}) and its disconnect notification also failed")]
    TransportAndDisconnectNotification { transport: Box<StratumV1Error> },
    #[error("Stratum connection exceeded its idle deadline")]
    IdleTimeout,
    #[error(transparent)]
    Progress(#[from] crate::progress::ProgressError),
}
