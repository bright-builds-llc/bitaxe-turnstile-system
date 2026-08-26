use std::str::FromStr as _;

use sqlx::postgres::PgPoolOptions;

use super::super::AuthorityPersistenceError;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations/gate_authority");

pub(crate) struct PostgresAuthorityRepository {
    pub(super) pool: sqlx::PgPool,
}

impl PostgresAuthorityRepository {
    pub(crate) async fn connect(database_url: &str) -> Result<Self, AuthorityPersistenceError> {
        let bootstrap_pool = PgPoolOptions::new()
            .max_connections(1)
            .connect(database_url)
            .await?;
        sqlx::query("CREATE SCHEMA IF NOT EXISTS gate_authority")
            .execute(&bootstrap_pool)
            .await?;
        bootstrap_pool.close().await;
        let connect_options = sqlx::postgres::PgConnectOptions::from_str(database_url)?
            .options([("search_path", "gate_authority,public")]);
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect_with(connect_options)
            .await?;
        MIGRATOR.run(&pool).await?;
        Ok(Self { pool })
    }
}
