use tauri::{WebviewUrl, WebviewWindowBuilder};

fn web_url() -> String {
    std::env::var("VALORANT_WEB_URL").unwrap_or_else(|_| "http://127.0.0.1:3000".to_owned())
}

fn parse_web_url() -> Result<url::Url, Box<dyn std::error::Error>> {
    let url = url::Url::parse(&web_url())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("VALORANT_WEB_URL must be an HTTP(S) URL".into());
    }
    Ok(url)
}

#[tauri::command]
fn configured_web_url() -> String {
    web_url()
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![configured_web_url])
        .setup(|app| {
            let url = parse_web_url()?;
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("VALORANT Analytics Coach")
                .inner_size(1440.0, 960.0)
                .min_inner_size(960.0, 640.0)
                .resizable(true)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running VALORANT Analytics desktop shell");
}
