use std::{collections::HashMap, sync::Mutex, time::Duration};

use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue},
    Client, Method,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::{InvokeBody, Request, Response};

// Raw request body layout (see src/tauri/ftElectron.js):
//   [u32 big-endian: metadata length][metadata JSON][request body bytes]
// Raw response layout:
//   [u32 big-endian: metadata length][metadata JSON][response body bytes]

#[derive(Deserialize)]
struct RequestMeta {
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    proxy: Option<String>,
}

#[derive(Serialize)]
struct ResponseMeta {
    status: u16,
    url: String,
    headers: Vec<(String, String)>,
}

/// One client per proxy setting. No cookie store on purpose: no tracking cookies are kept.
#[derive(Default)]
struct Clients(Mutex<HashMap<Option<String>, Client>>);

fn error_chain(error: &dyn std::error::Error) -> String {
    let mut message = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        message.push_str(&format!(": {cause}"));
        source = cause.source();
    }
    message
}

fn client_for(clients: &Clients, proxy: &Option<String>) -> Result<Client, String> {
    let mut map = clients.0.lock().map_err(|e| e.to_string())?;
    if let Some(client) = map.get(proxy) {
        return Ok(client.clone());
    }

    // HTTP/1.1 only: YouTube reset HTTP/2 streams from this client with PROTOCOL_ERROR.
    let mut builder = Client::builder()
        .http1_only()
        .connect_timeout(Duration::from_secs(30));
    if let Some(url) = proxy {
        builder = builder.proxy(reqwest::Proxy::all(url).map_err(|e| error_chain(&e))?);
    }
    let client = builder.build().map_err(|e| error_chain(&e))?;
    map.insert(proxy.clone(), client.clone());
    Ok(client)
}

#[tauri::command]
async fn native_fetch(
    clients: tauri::State<'_, Clients>,
    request: Request<'_>,
) -> Result<Response, String> {
    let InvokeBody::Raw(data) = request.body() else {
        return Err("expected a raw request body".into());
    };
    if data.len() < 4 {
        return Err("malformed request".into());
    }
    let meta_len = u32::from_be_bytes([data[0], data[1], data[2], data[3]]) as usize;
    let meta: RequestMeta =
        serde_json::from_slice(data.get(4..4 + meta_len).ok_or("malformed request")?)
            .map_err(|e| e.to_string())?;
    let body = data[4 + meta_len..].to_vec();

    if !(meta.url.starts_with("https://") || meta.url.starts_with("http://")) {
        return Err(format!("blocked non-http(s) url: {}", meta.url));
    }

    let mut headers = HeaderMap::new();
    // Connection-specific headers are managed by the HTTP client itself.
    const SKIP: [&str; 9] = [
        "connection", "keep-alive", "transfer-encoding", "te", "upgrade",
        "proxy-connection", "proxy-authorization", "host", "content-length",
    ];
    for (name, value) in &meta.headers {
        if SKIP.contains(&name.to_ascii_lowercase().as_str()) {
            continue;
        }
        headers.append(
            HeaderName::from_bytes(name.as_bytes()).map_err(|e| format!("bad header {name}: {e}"))?,
            HeaderValue::from_str(value).map_err(|e| format!("bad value for {name}: {e}"))?,
        );
    }

    let method = Method::from_bytes(meta.method.as_bytes()).map_err(|e| e.to_string())?;
    let client = client_for(&clients, &meta.proxy)?;

    let mut builder = client.request(method.clone(), &meta.url).headers(headers);
    if method != Method::GET && method != Method::HEAD && !body.is_empty() {
        builder = builder.body(body);
    }

    let response = builder
        .send()
        .await
        .map_err(|e| format!("{} [{}]", error_chain(&e), meta.url))?;

    let status = response.status().as_u16();
    let url = response.url().to_string();
    let response_headers = response
        .headers()
        .iter()
        .map(|(name, value)| (name.to_string(), String::from_utf8_lossy(value.as_bytes()).into_owned()))
        .collect();
    let bytes = response.bytes().await.map_err(|e| error_chain(&e))?;

    let meta_json = serde_json::to_vec(&ResponseMeta { status, url, headers: response_headers })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(4 + meta_json.len() + bytes.len());
    out.extend_from_slice(&(meta_json.len() as u32).to_be_bytes());
    out.extend_from_slice(&meta_json);
    out.extend_from_slice(&bytes);
    Ok(Response::new(out))
}

// The PO token (BotGuard) frame is served from its own URL scheme so that it runs with a real,
// non-opaque origin (BotGuard rejects sandboxed opaque-origin pages) while staying isolated from
// the app's own origin, so Google's script cannot read app data (settings, subscriptions...).
const BOTGUARD_FRAME_HTML: &str = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title></title></head><body><script src=\"/botGuardFrame.js\"></script></body></html>";

fn botguard_protocol<R: tauri::Runtime>(
    ctx: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let (status, mime, body): (u16, &str, Vec<u8>) = match request.uri().path() {
        "/frame.html" => (200, "text/html; charset=utf-8", BOTGUARD_FRAME_HTML.as_bytes().to_vec()),
        "/botGuardFrame.js" => match ctx.app_handle().asset_resolver().get("botGuardFrame.js".into()) {
            Some(asset) => (200, "text/javascript; charset=utf-8", asset.bytes),
            None => (404, "text/plain", b"not found".to_vec()),
        },
        _ => (404, "text/plain", b"not found".to_vec()),
    };

    tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .body(body)
        .unwrap()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // WebKitGTK's DMA-BUF renderer leaves the window blank after a resize on some GPU/driver setups.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    tauri::Builder::default()
        .manage(Clients::default())
        .setup(|app| {
            let mut window = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
                .title("ThornsTube")
                .inner_size(1200.0, 800.0)
                .min_inner_size(400.0, 300.0);

            // WebKitGTK reports a bogus "Version/60.5" which YouTube's bot detection can flag.
            #[cfg(target_os = "linux")]
            {
                window = window.user_agent(
                    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
                );
            }

            let _ = &mut window;
            window.build()?;
            Ok(())
        })
        .register_uri_scheme_protocol("ftbotguard", |ctx, request| botguard_protocol(ctx, request))
        .invoke_handler(tauri::generate_handler![native_fetch])
        .run(tauri::generate_context!())
        .expect("error while running ThornsTube");
}
