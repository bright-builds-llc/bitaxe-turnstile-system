use std::error::Error;

use testcontainers::{
    ContainerAsync, GenericImage, ImageExt as _, core::IntoContainerPort as _, core::WaitFor,
    runners::AsyncRunner as _,
};

pub struct PostgresTestDatabase {
    _container: ContainerAsync<GenericImage>,
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
            _container: container,
            database_url: format!("postgres://bwg_test:bwg_test_password@{host}:{port}/bwg_test"),
        })
    }

    pub fn database_url(&self) -> &str {
        &self.database_url
    }
}
