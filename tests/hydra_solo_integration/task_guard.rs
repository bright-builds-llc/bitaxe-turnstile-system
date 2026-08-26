use std::time::Duration;

use tokio::task::{JoinError, JoinHandle};

pub(super) enum TaskCompletion<T> {
    Completed(T),
    DeadlineAborted,
}

/// Owns a spawned task and guarantees cancellation if its surrounding flow exits early.
pub(super) struct AbortTaskOnDrop<T> {
    maybe_task: Option<JoinHandle<T>>,
}

impl<T> AbortTaskOnDrop<T> {
    pub(super) fn new(task: JoinHandle<T>) -> Self {
        Self {
            maybe_task: Some(task),
        }
    }

    pub(super) async fn finish(
        mut self,
        deadline: Duration,
    ) -> Result<TaskCompletion<T>, JoinError> {
        let result = {
            let task = self
                .maybe_task
                .as_mut()
                .expect("task guard always owns a task until it is finished");
            tokio::time::timeout(deadline, task).await
        };
        match result {
            Ok(result) => {
                self.maybe_task.take();
                Ok(TaskCompletion::Completed(result?))
            }
            Err(_) => {
                let task = self
                    .maybe_task
                    .take()
                    .expect("timed-out guard must still own its task");
                task.abort();
                let result = task.await;
                debug_assert!(result.is_err_and(|error| error.is_cancelled()));
                Ok(TaskCompletion::DeadlineAborted)
            }
        }
    }

    pub(super) async fn abort(mut self) -> Result<(), JoinError> {
        let task = self
            .maybe_task
            .take()
            .expect("task guard always owns a task until it is aborted");
        task.abort();
        match task.await {
            Ok(_result) => Ok(()),
            Err(error) if error.is_cancelled() => Ok(()),
            Err(error) => Err(error),
        }
    }
}

impl<T> Drop for AbortTaskOnDrop<T> {
    fn drop(&mut self) {
        if let Some(task) = self.maybe_task.take() {
            task.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;

    struct DropSignal(Option<oneshot::Sender<()>>);

    impl Drop for DropSignal {
        fn drop(&mut self) {
            if let Some(sender) = self.0.take() {
                let _result = sender.send(());
            }
        }
    }

    async fn fail_before_height<T>(_guard: AbortTaskOnDrop<T>) -> Result<(), &'static str> {
        Err("height wait failed")
    }

    #[tokio::test]
    async fn pre_height_failure_aborts_the_observer_task() {
        // Arrange
        let (dropped_tx, dropped_rx) = oneshot::channel();
        let task = tokio::spawn(async move {
            let _signal = DropSignal(Some(dropped_tx));
            std::future::pending::<()>().await;
        });
        tokio::task::yield_now().await;
        let guard = AbortTaskOnDrop::new(task);

        // Act
        let result = fail_before_height(guard).await;

        // Assert
        assert_eq!(result, Err("height wait failed"));
        tokio::time::timeout(Duration::from_secs(1), dropped_rx)
            .await
            .expect("aborted observer must drop promptly")
            .expect("drop signal sender must run");
    }

    #[tokio::test]
    async fn cancelling_finish_aborts_the_observer_task() {
        // Arrange
        let (dropped_tx, dropped_rx) = oneshot::channel();
        let observer = tokio::spawn(async move {
            let _signal = DropSignal(Some(dropped_tx));
            std::future::pending::<()>().await;
        });
        tokio::task::yield_now().await;
        let guard = AbortTaskOnDrop::new(observer);
        let finish_task = tokio::spawn(guard.finish(Duration::from_secs(60)));
        tokio::task::yield_now().await;

        // Act
        finish_task.abort();
        assert!(finish_task.await.is_err_and(|error| error.is_cancelled()));

        // Assert
        tokio::time::timeout(Duration::from_secs(1), dropped_rx)
            .await
            .expect("cancelled finish must abort its observer")
            .expect("drop signal sender must run");
    }
}
