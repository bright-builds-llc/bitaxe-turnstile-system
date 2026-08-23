//! Bitcoin Work Gate Core domain and public HTTP adapters.

pub mod authority;
mod authority_application;
pub mod authority_descriptor;
mod authority_persistence;
pub mod challenge;
pub mod crypto_profile;
pub mod governance;
pub mod progress;
pub mod redemption;
mod reference_application;
mod reference_persistence;
pub mod reference_service;
pub mod service_auth;
pub mod web_url;
pub mod work;
