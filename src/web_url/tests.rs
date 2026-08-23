use super::*;

#[test]
fn https_url_accepts_a_parsed_secure_url() -> Result<(), WebUrlError> {
    // Arrange
    let value = "https://authority.example/policies/operator".to_owned();

    // Act
    let parsed = HttpsUrl::try_from(value.clone())?;

    // Assert
    assert_eq!(parsed.as_str(), value);

    Ok(())
}

#[test]
fn https_url_rejects_malformed_or_ambient_components() {
    // Arrange
    let invalid = [
        "https://",
        "https://exa mple.test",
        "https://authority.example:invalid",
        "https://user@authority.example",
        "https://authority.example?query=true",
        "https://authority.example#fragment",
        "http://authority.example",
    ];

    // Act
    let results = invalid.map(|value| HttpsUrl::try_from(value.to_owned()));

    // Assert
    assert!(results.into_iter().all(|result| result.is_err()));
}

#[test]
fn https_origin_normalizes_scheme_host_and_port() -> Result<(), WebUrlError> {
    // Arrange
    let value = "https://App.Example:8443".to_owned();

    // Act
    let origin = HttpsOrigin::try_from(value)?;

    // Assert
    assert_eq!(origin.as_str(), "https://app.example:8443");

    Ok(())
}

#[test]
fn https_origin_rejects_paths_queries_and_malformed_ports() {
    // Arrange
    let invalid = [
        "https://app.example/path",
        "https://app.example?query=true",
        "https://app.example:invalid",
        "https://",
        "http://app.example",
    ];

    // Act
    let results = invalid.map(|value| HttpsOrigin::try_from(value.to_owned()));

    // Assert
    assert!(results.into_iter().all(|result| result.is_err()));
}

#[test]
fn authority_endpoint_allows_https_and_loopback_http() {
    // Arrange
    let values = [
        "https://authority.example",
        "http://127.0.0.1:3000",
        "http://[::1]:3000",
        "http://localhost:3000",
    ];

    // Act
    let results = values.map(|value| AuthorityEndpointUrl::try_from(value.to_owned()));

    // Assert
    assert!(results.into_iter().all(|result| result.is_ok()));
}

#[test]
fn authority_endpoint_rejects_insecure_remote_http() {
    // Arrange
    let value = "http://authority.example".to_owned();

    // Act
    let result = AuthorityEndpointUrl::try_from(value);

    // Assert
    assert_eq!(result, Err(WebUrlError::InvalidAuthorityEndpoint));
}
