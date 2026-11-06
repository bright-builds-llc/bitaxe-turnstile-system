use std::{error::Error, time::Duration};

use sqlx::postgres::PgPoolOptions;

use testcontainers::{
    ContainerAsync, GenericImage, ImageExt as _, core::IntoContainerPort as _, core::WaitFor,
    runners::AsyncRunner as _,
};

const READINESS_TIMEOUT: Duration = Duration::from_secs(30);
const READINESS_POLL: Duration = Duration::from_millis(250);

pub struct PostgresTestDatabase {
    // Each integration-test binary compiles this shared helper independently.
    #[allow(dead_code)]
    container: ContainerAsync<GenericImage>,
    database_url: String,
}

impl PostgresTestDatabase {
    pub async fn start() -> Result<Self, Box<dyn Error>> {
        let container = GenericImage::new("postgres", "16-alpine")
            .with_exposed_port(5432.tcp())
            .with_wait_for(WaitFor::message_on_stderr(
                "database system is ready to accept connections",
            ))
            .with_env_var("POSTGRES_DB", "bwg_test")
            .with_env_var("POSTGRES_USER", "bwg_test")
            .with_env_var("POSTGRES_PASSWORD", "bwg_test_password")
            .start()
            .await?;
        let host = container.get_host().await?;
        let port = container.get_host_port_ipv4(5432).await?;
        let database = Self {
            container,
            database_url: format!("postgres://bwg_test:bwg_test_password@{host}:{port}/bwg_test"),
        };
        database.wait_until_queryable().await?;
        Ok(database)
    }

    /// The image logs "ready" from its temporary init server too, so wait for a real query.
    async fn wait_until_queryable(&self) -> Result<(), Box<dyn Error>> {
        let deadline = tokio::time::Instant::now() + READINESS_TIMEOUT;
        loop {
            let error = match self.query_once().await {
                Ok(()) => return Ok(()),
                Err(error) => error,
            };
            if tokio::time::Instant::now() >= deadline {
                return Err(format!("PostgreSQL did not accept queries: {error}").into());
            }
            tokio::time::sleep(READINESS_POLL).await;
        }
    }

    async fn query_once(&self) -> Result<(), sqlx::Error> {
        let pool = PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(READINESS_POLL)
            .connect(&self.database_url)
            .await?;
        let result = sqlx::query("SELECT 1").execute(&pool).await.map(|_| ());
        pool.close().await;
        result
    }

    pub fn database_url(&self) -> &str {
        &self.database_url
    }

    #[allow(dead_code)]
    pub async fn pause(&self) -> Result<(), Box<dyn Error>> {
        self.container.pause().await?;
        Ok(())
    }

    #[allow(dead_code)]
    pub async fn resume(&self) -> Result<(), Box<dyn Error>> {
        self.container.unpause().await?;
        let readiness_pool = PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(Duration::from_secs(20))
            .connect(&self.database_url)
            .await?;
        readiness_pool.close().await;
        Ok(())
    }
}
