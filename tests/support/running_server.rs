use std::error::Error;

use axum::Router;
use tokio::net::TcpListener;

pub(crate) struct RunningServer {
    pub(crate) base_url: String,
    task: tokio::task::JoinHandle<()>,
}

impl RunningServer {
    pub(crate) async fn spawn(router: Router) -> Result<Self, Box<dyn Error>> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let task = tokio::spawn(async move {
            axum::serve(listener, router)
                .await
                .expect("test Authority should run until stopped");
        });
        Ok(Self {
            base_url: format!("http://{address}"),
            task,
        })
    }

    pub(crate) fn stop(self) {
        self.task.abort();
    }
}
