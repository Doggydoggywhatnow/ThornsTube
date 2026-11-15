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

    let mut builder = Client::builder().connect_timeout(Duration::from_secs(30));
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
    for (name, value) in &meta.headers {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Clients::default())
        .invoke_handler(tauri::generate_handler![native_fetch])
        .run(tauri::generate_context!())
        .expect("error while running ThornsTube");
}
