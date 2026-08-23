use std::{error::Error, io::Write as _, net::TcpStream};

pub fn send_get_without_reading_response(
    request_url: &str,
    header_name: &str,
    header_value: &str,
) -> Result<TcpStream, Box<dyn Error>> {
    let url = url::Url::parse(request_url)?;
    let host = url.host_str().ok_or("request URL needs a host")?;
    let port = url
        .port_or_known_default()
        .ok_or("request URL needs a port")?;
    let mut stream = TcpStream::connect((host, port))?;
    let request = format!(
        "GET {} HTTP/1.1\r\nHost: {host}:{port}\r\n{header_name}: {header_value}\r\nConnection: close\r\n\r\n",
        url.path()
    );
    stream.write_all(request.as_bytes())?;
    Ok(stream)
}

// Integration-test binaries compile this shared support module independently.
#[allow(dead_code)]
pub fn send_json_post_without_reading_response(
    request_url: &str,
    body: &serde_json::Value,
) -> Result<TcpStream, Box<dyn Error>> {
    let url = url::Url::parse(request_url)?;
    let host = url.host_str().ok_or("request URL needs a host")?;
    let port = url
        .port_or_known_default()
        .ok_or("request URL needs a port")?;
    let body = serde_json::to_vec(body)?;
    let mut stream = TcpStream::connect((host, port))?;
    let request = format!(
        "POST {} HTTP/1.1\r\nHost: {host}:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        url.path(),
        body.len()
    );
    stream.write_all(request.as_bytes())?;
    stream.write_all(&body)?;
    Ok(stream)
}
