//! Give packaged webviews a real HTTP origin for YouTube referrers and
//! Twitch's frame-ancestors checks. Only compiled public assets are served;
//! settings, tokens, filesystem paths and IPC are never HTTP endpoints.
use std::{collections::HashMap, net::TcpListener, sync::Arc, thread};

use tauri::{utils::config::FrontendDist, Context, Runtime};
use tiny_http::{Header, Method, Response, Server, StatusCode};

struct Asset {
    bytes: Vec<u8>,
    mime: String,
}

pub struct LocalAssets {
    server: Arc<Server>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Drop for LocalAssets {
    fn drop(&mut self) {
        self.server.unblock();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

pub fn start<R: Runtime>(context: &mut Context<R>) -> anyhow::Result<Option<LocalAssets>> {
    if tauri::is_dev() {
        return Ok(None);
    }

    let assets = context
        .assets()
        .iter()
        .filter_map(|(key, _)| {
            let bytes = context.assets().get(&key.as_ref().into())?.into_owned();
            let mime = tauri::utils::mime_type::MimeType::parse(&bytes, &key);
            Some((
                key.trim_start_matches('/').to_string(),
                Asset { bytes, mime },
            ))
        })
        .collect::<HashMap<_, _>>();
    anyhow::ensure!(
        assets.contains_key("index.html"),
        "missing bundled index.html"
    );

    // Bind first and retain that very listener: no port-picking race, no
    // exposure to the LAN, and separate app instances cannot claim each other.
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
    let host = format!("localhost:{}", listener.local_addr()?.port());
    let origin = format!("http://{host}");
    let server = Arc::new(
        Server::from_listener(listener, None)
            .map_err(|error| anyhow::anyhow!(error.to_string()))?,
    );
    let worker_server = Arc::clone(&server);
    let app_origin = origin.clone();
    let worker = thread::Builder::new()
        .name("local-assets".into())
        .spawn(move || {
            // recv() returns an error when the owner unblocks the server on exit.
            while let Ok(request) = worker_server.recv() {
                let header = |name: &str| {
                    request
                        .headers()
                        .iter()
                        .find(|header| header.field.as_str().as_str().eq_ignore_ascii_case(name))
                        .map(|header| header.value.as_str())
                };
                let result = asset_path(
                    request.method(),
                    request.url(),
                    header("Host"),
                    header("Origin"),
                    &host,
                    &origin,
                );
                let response = match result {
                    Ok(path) => match assets.get(path) {
                        Some(asset) => Response::from_data(asset.bytes.clone())
                            .with_header(header_value("Content-Type", &asset.mime)),
                        None => Response::from_data(Vec::new()).with_status_code(StatusCode(404)),
                    },
                    Err(status) => {
                        Response::from_data(Vec::new()).with_status_code(StatusCode(status))
                    }
                };
                let _ = request.respond(
                    response
                        .with_header(header_value("Cache-Control", "no-store"))
                        .with_header(header_value("X-Content-Type-Options", "nosniff"))
                        .with_header(header_value(
                            "Referrer-Policy",
                            "strict-origin-when-cross-origin",
                        ))
                        .with_header(header_value(
                            "Content-Security-Policy",
                            "frame-ancestors 'none'",
                        )),
                );
            }
        })?;

    // Set only this process's exact app origin. WebviewUrl::App in both main
    // and child windows resolves here, preserving Tauri's local IPC boundary
    // without granting remote capabilities or serving IPC through HTTP.
    context.config_mut().build.frontend_dist = Some(FrontendDist::Url(app_origin.parse()?));
    Ok(Some(LocalAssets {
        server,
        worker: Some(worker),
    }))
}

fn header_value(name: &str, value: &str) -> Header {
    Header::from_bytes(name, value).expect("valid static asset response header")
}

fn asset_path<'a>(
    method: &Method,
    target: &'a str,
    host: Option<&str>,
    origin: Option<&str>,
    expected_host: &str,
    expected_origin: &str,
) -> Result<&'a str, u16> {
    // Reject DNS rebinding and cross-origin fetches. There are deliberately
    // no Access-Control-Allow-* headers and no catch-all index fallback.
    if host != Some(expected_host) || origin.is_some_and(|value| value != expected_origin) {
        return Err(403);
    }
    if !matches!(method, Method::Get | Method::Head) {
        return Err(405);
    }
    let path = target.split('?').next().unwrap_or(target);
    if !path.starts_with('/')
        || path.starts_with("//")
        || path.contains(['%', '\\'])
        || path.split('/').any(|part| matches!(part, "." | ".."))
    {
        return Err(404);
    }
    Ok(if path == "/" {
        "index.html"
    } else {
        &path[1..]
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path<'a>(
        method: &Method,
        target: &'a str,
        host: Option<&str>,
        origin: Option<&str>,
    ) -> Result<&'a str, u16> {
        asset_path(
            method,
            target,
            host,
            origin,
            "localhost:54321",
            "http://localhost:54321",
        )
    }

    #[test]
    fn serves_only_exact_local_origin_and_read_methods() {
        assert_eq!(
            path(&Method::Get, "/", Some("localhost:54321"), None),
            Ok("index.html")
        );
        assert_eq!(
            path(
                &Method::Head,
                "/assets/app.js?v=1",
                Some("localhost:54321"),
                Some("http://localhost:54321")
            ),
            Ok("assets/app.js")
        );
        for host in [
            None,
            Some("evil.example:54321"),
            Some("localhost:12345"),
            Some("127.0.0.1:54321"),
        ] {
            assert_eq!(path(&Method::Get, "/", host, None), Err(403));
        }
        for origin in ["null", "https://evil.example", "http://localhost:12345"] {
            assert_eq!(
                path(&Method::Get, "/", Some("localhost:54321"), Some(origin)),
                Err(403)
            );
        }
        assert_eq!(
            path(&Method::Post, "/", Some("localhost:54321"), None),
            Err(405)
        );
    }

    #[test]
    fn rejects_paths_that_could_escape_the_asset_map() {
        for target in [
            "//evil.example/",
            "/../settings.json",
            "/assets/./app.js",
            "/%2e%2e/settings.json",
            "/assets\\app.js",
            "http://localhost:54321/",
        ] {
            assert_eq!(
                path(&Method::Get, target, Some("localhost:54321"), None),
                Err(404)
            );
        }
    }
}
