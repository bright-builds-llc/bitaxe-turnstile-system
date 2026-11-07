use std::collections::{HashMap, VecDeque};

use super::StratumJob;

/// Outlasts Hydra's 15-minute job age at its new job about every 10 s, so the proxy
/// never refuses a job Hydra would still take.
const MAXIMUM_RETAINED_JOBS: usize = 96;
/// Remembers twice as many dropped IDs as it retains, so a clean notify's whole
/// batch still reads as stale.
const MAXIMUM_DROPPED_JOBS: usize = 2 * MAXIMUM_RETAINED_JOBS;

/// Why a submit names a job the session does not hold. Both are answered with
/// Stratum error 21, which miners count as stale; the message tells them apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnheldJob {
    /// The session held this job and dropped it: a clean notify or eviction.
    Stale,
    /// The proxy never sent this job to the session.
    Unknown,
}

impl UnheldJob {
    /// Stable label for logs and run evidence.
    pub fn code(self) -> &'static str {
        match self {
            Self::Stale => "stale_job",
            Self::Unknown => "unknown_job",
        }
    }

    /// The Worker-facing error 21 reply for request `id`, given as canonical JSON.
    pub(super) fn worker_response(self, id: &str) -> String {
        let message = match self {
            Self::Stale => "Stale job",
            Self::Unknown => "Job not found",
        };
        format!("{{\"id\":{id},\"result\":null,\"error\":[21,\"{message}\",null]}}")
    }
}

/// The session's bounded job state: retained jobs oldest first, and the IDs it
/// recently dropped.
#[derive(Default)]
pub(super) struct RetainedJobs {
    jobs: HashMap<String, StratumJob>,
    order: VecDeque<String>,
    dropped: VecDeque<String>,
}

impl RetainedJobs {
    pub(super) fn get(&self, job_id: &str) -> Result<&StratumJob, UnheldJob> {
        if let Some(job) = self.jobs.get(job_id) {
            return Ok(job);
        }
        if self.dropped.iter().any(|dropped| dropped == job_id) {
            return Err(UnheldJob::Stale);
        }
        Err(UnheldJob::Unknown)
    }

    /// Drops every retained job, as a clean notify requires.
    pub(super) fn clear(&mut self) {
        self.jobs.clear();
        while let Some(job_id) = self.order.pop_front() {
            self.remember_dropped(job_id);
        }
    }

    /// Retains `job`, dropping the oldest once the bound is reached.
    pub(super) fn retain(&mut self, job_id: &str, job: StratumJob) {
        if self.jobs.insert(job_id.to_owned(), job).is_some() {
            return;
        }
        self.dropped.retain(|dropped| dropped != job_id);
        self.order.push_back(job_id.to_owned());
        if self.order.len() > MAXIMUM_RETAINED_JOBS
            && let Some(oldest) = self.order.pop_front()
        {
            self.jobs.remove(&oldest);
            self.remember_dropped(oldest);
        }
    }

    fn remember_dropped(&mut self, job_id: String) {
        self.dropped.push_back(job_id);
        if self.dropped.len() > MAXIMUM_DROPPED_JOBS {
            self.dropped.pop_front();
        }
    }
}
