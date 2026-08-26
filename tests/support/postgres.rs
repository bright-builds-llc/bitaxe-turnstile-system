use std::{error::Error, time::Duration};

use sqlx::postgres::PgPoolOptions;

use testcontainers::{
    ContainerAsync, GenericImage, ImageExt as _, core::IntoContainerPort as _, core::WaitFor,
    runners::AsyncRunner as _,
};

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

        Ok(Self {
            container,
            database_url: format!("postgres://bwg_test:bwg_test_password@{host}:{port}/bwg_test"),
        })
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
