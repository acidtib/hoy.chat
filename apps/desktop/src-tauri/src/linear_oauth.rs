// Linear OAuth (HOY-346): authorization code + PKCE through the system browser
// and a one-shot loopback listener. PKCE makes the client secret optional on
// Linear's token endpoint, so none ships in the binary.

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri_plugin_opener::OpenerExt;

use crate::linear::{http_client, now_ms, OAuthTokens};

// The public client id of Hoy's Linear OAuth app. A build can override it with
// HOY_LINEAR_CLIENT_ID; an empty id disables OAuth and leaves only API keys.
const CLIENT_ID: &str = match option_env!("HOY_LINEAR_CLIENT_ID") {
    Some(id) => id,
    None => "4ba68f08b83505ad3eba467d7ecf1f97",
};

// Must match the redirect URL registered on the Linear OAuth app exactly.
const PORT: u16 = 47321;
const REDIRECT_URI: &str = "http://127.0.0.1:47321/callback";
const SCOPES: &str = "read,write";

const AUTHORIZE_URL: &str = "https://linear.app/oauth/authorize";
const TOKEN_URL: &str = "https://api.linear.app/oauth/token";
const REVOKE_URL: &str = "https://api.linear.app/oauth/revoke";

const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);

// Bumped by every login and cancel; a listener whose generation is stale exits.
static GENERATION: AtomicU64 = AtomicU64::new(0);

pub fn available() -> bool {
    !CLIENT_ID.is_empty()
}

pub fn cancel() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("random: {e}"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn challenge_for(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn authorize_url(state: &str, challenge: &str) -> String {
    let mut url = url::Url::parse(AUTHORIZE_URL).expect("static url");
    url.query_pairs_mut()
        .append_pair("client_id", CLIENT_ID)
        .append_pair("redirect_uri", REDIRECT_URI)
        .append_pair("response_type", "code")
        .append_pair("scope", SCOPES)
        .append_pair("state", state)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("prompt", "consent");
    url.into()
}

pub async fn login(app: &tauri::AppHandle) -> Result<OAuthTokens, String> {
    if !available() {
        return Err("This build has no Linear OAuth client id".to_string());
    }
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let verifier = random_token()?;
    let state = random_token()?;
    // Bind before opening the browser so the redirect can never beat us.
    let listener = bind_listener()?;
    app.opener()
        .open_url(
            authorize_url(&state, &challenge_for(&verifier)),
            None::<&str>,
        )
        .map_err(|e| format!("open browser: {e}"))?;

    let expected = state.clone();
    let code = tokio::task::spawn_blocking(move || wait_for_code(listener, &expected, generation))
        .await
        .map_err(|e| format!("sign-in task: {e}"))??;
    exchange(&code, &verifier).await
}

// A previous attempt's listener can hold the port for one poll interval after
// cancel, so retry briefly.
fn bind_listener() -> Result<TcpListener, String> {
    let mut last = None;
    for _ in 0..10 {
        match TcpListener::bind(("127.0.0.1", PORT)) {
            Ok(l) => {
                l.set_nonblocking(true)
                    .map_err(|e| format!("listener: {e}"))?;
                return Ok(l);
            }
            Err(e) => {
                last = Some(e);
                std::thread::sleep(Duration::from_millis(150));
            }
        }
    }
    Err(format!(
        "Port {PORT} is busy, so the Linear sign-in callback cannot be received: {}",
        last.map(|e| e.to_string()).unwrap_or_default()
    ))
}

fn wait_for_code(listener: TcpListener, state: &str, generation: u64) -> Result<String, String> {
    let deadline = Instant::now() + LOGIN_TIMEOUT;
    loop {
        if GENERATION.load(Ordering::SeqCst) != generation {
            return Err("Sign-in cancelled".to_string());
        }
        if Instant::now() > deadline {
            return Err("Sign-in timed out".to_string());
        }
        let mut stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            Err(e) => return Err(format!("callback listener: {e}")),
        };
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut buf = [0u8; 4096];
        let n = stream.read(&mut buf).unwrap_or(0);
        let request = String::from_utf8_lossy(&buf[..n]);
        let Some(outcome) = parse_callback(&request, state) else {
            // Favicon and other stray requests.
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
            continue;
        };
        let message = match &outcome {
            Ok(_) => "Hoy is connected to Linear. You can close this tab.",
            Err(_) => {
                "Linear sign-in did not complete. You can close this tab and try again in Hoy."
            }
        };
        let html = format!(
            "<!doctype html><meta charset=utf-8><title>Hoy</title>\
             <body style=\"font:14px system-ui;background:#141316;color:#eee;display:grid;place-items:center;height:100vh;margin:0\">{message}</body>"
        );
        let _ = stream.write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
                html.len()
            )
            .as_bytes(),
        );
        return outcome;
    }
}

// None for requests that are not the callback. Some(Err) when Linear reports an
// error or the state does not match (a forged or stale redirect).
fn parse_callback(request: &str, state: &str) -> Option<Result<String, String>> {
    let target = request.lines().next()?.split_whitespace().nth(1)?;
    let url = url::Url::parse(&format!("http://127.0.0.1{target}")).ok()?;
    if url.path() != "/callback" {
        return None;
    }
    let param = |name: &str| {
        url.query_pairs()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.into_owned())
    };
    if let Some(error) = param("error") {
        let detail = param("error_description").unwrap_or(error);
        return Some(Err(format!("Linear declined the sign-in: {detail}")));
    }
    if param("state").as_deref() != Some(state) {
        return Some(Err("Sign-in state did not match; try again".to_string()));
    }
    Some(param("code").ok_or_else(|| "Linear sent no authorization code".to_string()))
}

async fn token_request(pairs: &[(&str, &str)]) -> Result<OAuthTokens, String> {
    let body = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs)
        .finish();
    let response = http_client()?
        .post(TOKEN_URL)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Could not reach Linear: {e}"))?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|e| format!("Linear token endpoint returned {status}: {e}"))?;
    parse_token_response(&body, now_ms())
}

fn parse_token_response(body: &Value, now: u64) -> Result<OAuthTokens, String> {
    if let Some(error) = body.get("error").and_then(Value::as_str) {
        let detail = body
            .get("error_description")
            .and_then(Value::as_str)
            .unwrap_or(error);
        return Err(format!("Linear sign-in failed: {detail}"));
    }
    let access_token = body
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or("Linear token response missing access_token")?
        .to_string();
    // Linear issues 24 h tokens; assume that if expires_in is absent.
    let expires_in = body
        .get("expires_in")
        .and_then(Value::as_u64)
        .unwrap_or(86_400);
    Ok(OAuthTokens {
        access_token,
        refresh_token: body
            .get("refresh_token")
            .and_then(Value::as_str)
            .map(str::to_string),
        expires_at: now + expires_in * 1000,
    })
}

async fn exchange(code: &str, verifier: &str) -> Result<OAuthTokens, String> {
    token_request(&[
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", REDIRECT_URI),
        ("client_id", CLIENT_ID),
        ("code_verifier", verifier),
    ])
    .await
}

pub async fn refresh(refresh_token: &str) -> Result<OAuthTokens, String> {
    let mut tokens = token_request(&[
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", CLIENT_ID),
    ])
    .await?;
    // Keep the old refresh token if Linear did not rotate it.
    if tokens.refresh_token.is_none() {
        tokens.refresh_token = Some(refresh_token.to_string());
    }
    Ok(tokens)
}

pub async fn revoke(access_token: &str) -> Result<(), String> {
    http_client()?
        .post(REVOKE_URL)
        .header("Authorization", format!("Bearer {access_token}"))
        .send()
        .await
        .map_err(|e| format!("revoke: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pkce_challenge_matches_rfc7636_example() {
        // RFC 7636 appendix B.
        assert_eq!(
            challenge_for("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn random_tokens_are_url_safe_and_distinct() {
        let a = random_token().unwrap();
        let b = random_token().unwrap();
        assert_ne!(a, b);
        assert_eq!(a.len(), 43);
        assert!(a
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn authorize_url_carries_pkce_and_the_registered_redirect() {
        let url = url::Url::parse(&authorize_url("st", "ch")).unwrap();
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(q["redirect_uri"], REDIRECT_URI);
        assert_eq!(q["code_challenge"], "ch");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["state"], "st");
        assert_eq!(q["response_type"], "code");
        assert_eq!(q["scope"], "read,write");
    }

    #[test]
    fn callback_parsing() {
        let req = |target: &str| format!("GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
        assert_eq!(parse_callback(&req("/favicon.ico"), "s"), None);
        assert_eq!(
            parse_callback(&req("/callback?code=abc&state=s"), "s"),
            Some(Ok("abc".into()))
        );
        assert!(matches!(
            parse_callback(&req("/callback?code=abc&state=other"), "s"),
            Some(Err(_))
        ));
        assert_eq!(
            parse_callback(
                &req("/callback?error=access_denied&error_description=User%20said%20no&state=s"),
                "s"
            ),
            Some(Err("Linear declined the sign-in: User said no".into()))
        );
        assert!(matches!(
            parse_callback(&req("/callback?state=s"), "s"),
            Some(Err(_))
        ));
    }

    #[test]
    fn token_response_parsing() {
        let tokens = parse_token_response(
            &json!({ "access_token": "at", "refresh_token": "rt", "expires_in": 100, "token_type": "Bearer" }),
            1_000,
        )
        .unwrap();
        assert_eq!(tokens.access_token, "at");
        assert_eq!(tokens.refresh_token.as_deref(), Some("rt"));
        assert_eq!(tokens.expires_at, 101_000);
        assert_eq!(
            parse_token_response(
                &json!({ "error": "invalid_grant", "error_description": "Code expired" }),
                0
            )
            .unwrap_err(),
            "Linear sign-in failed: Code expired"
        );
    }

    #[test]
    fn listener_returns_the_code_from_a_real_callback() {
        let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let waiter = std::thread::spawn(move || wait_for_code(listener, "st", generation));
        let mut stray = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        stray
            .write_all(b"GET /favicon.ico HTTP/1.1\r\n\r\n")
            .unwrap();
        let mut sink = String::new();
        let _ = stray.read_to_string(&mut sink);
        let mut real = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        real.write_all(b"GET /callback?code=xyz&state=st HTTP/1.1\r\n\r\n")
            .unwrap();
        let mut page = String::new();
        let _ = real.read_to_string(&mut page);
        assert!(page.starts_with("HTTP/1.1 200 OK"));
        assert_eq!(waiter.join().unwrap(), Ok("xyz".into()));
    }
}
