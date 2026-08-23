use serde::{Deserialize, Deserializer, Serialize};
use thiserror::Error;
use url::{Host, Url};

#[cfg(test)]
mod tests;

/// A parsed HTTPS URL without credentials, query, or fragment components.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct HttpsUrl(String);

impl HttpsUrl {
    /// Returns the validated URL text.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for HttpsUrl {
    type Error = WebUrlError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        let parsed = parse_without_ambient_components(&value)?;
        if parsed.scheme() != "https" || parsed.host().is_none() {
            return Err(WebUrlError::InvalidHttpsUrl);
        }
        Ok(Self(value))
    }
}

impl<'de> Deserialize<'de> for HttpsUrl {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::try_from(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

/// A parsed HTTPS origin normalized to scheme, host, and optional port.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct HttpsOrigin(String);

impl HttpsOrigin {
    /// Returns the normalized origin text.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for HttpsOrigin {
    type Error = WebUrlError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        let parsed = parse_without_ambient_components(&value)?;
        if parsed.scheme() != "https" || parsed.host().is_none() || parsed.path() != "/" {
            return Err(WebUrlError::InvalidHttpsOrigin);
        }
        let origin = parsed.origin().ascii_serialization();
        if origin == "null" {
            return Err(WebUrlError::InvalidHttpsOrigin);
        }
        Ok(Self(origin))
    }
}

impl<'de> Deserialize<'de> for HttpsOrigin {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        Self::try_from(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

/// A parsed Authority endpoint base: HTTPS, or HTTP only on a loopback host.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct AuthorityEndpointUrl(String);

impl AuthorityEndpointUrl {
    /// Returns the validated endpoint text without a trailing slash.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for AuthorityEndpointUrl {
    type Error = WebUrlError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        let parsed = parse_without_ambient_components(&value)?;
        let secure = parsed.scheme() == "https" && parsed.host().is_some();
        let loopback = parsed.scheme() == "http" && is_loopback_host(parsed.host());
        if !secure && !loopback {
            return Err(WebUrlError::InvalidAuthorityEndpoint);
        }
        Ok(Self(value.trim_end_matches('/').to_owned()))
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum WebUrlError {
    #[error("value is not a valid URL")]
    InvalidUrl,
    #[error("value must be a valid HTTPS URL")]
    InvalidHttpsUrl,
    #[error("value must be a valid HTTPS origin")]
    InvalidHttpsOrigin,
    #[error("Authority endpoint must use HTTPS or loopback HTTP")]
    InvalidAuthorityEndpoint,
}

fn parse_without_ambient_components(value: &str) -> Result<Url, WebUrlError> {
    let parsed = Url::parse(value).map_err(|_| WebUrlError::InvalidUrl)?;
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(WebUrlError::InvalidUrl);
    }
    Ok(parsed)
}

fn is_loopback_host(maybe_host: Option<Host<&str>>) -> bool {
    match maybe_host {
        Some(Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(address)) => address.is_loopback(),
        Some(Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
}
