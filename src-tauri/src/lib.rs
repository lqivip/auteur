//! AUTEUR desktop shell.
//!
//! The shell is deliberately thin: it starts the Node server sidecar
//! (see scripts/build-sidecar.mjs), waits until the server answers
//! /api/health, then opens the single app window on the server's own
//! origin. The server serves the built web UI itself, so the window is
//! just http://127.0.0.1:4377/ — the same address a browser would use.
//! When the app exits, the sidecar is killed.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

const SERVER_PORT: u16 = 4377;

struct SidecarState(Mutex<Option<CommandChild>>);

/// Poll GET /api/health until the sidecar answers 200 or time runs out.
fn wait_for_server(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    let addr = format!("127.0.0.1:{port}");
    while Instant::now() < deadline {
        if let Ok(mut stream) = TcpStream::connect(&addr) {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let request = b"GET /api/health HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n";
            if stream.write_all(request).is_ok() {
                let mut buf = [0u8; 128];
                if let Ok(n) = stream.read(&mut buf) {
                    if String::from_utf8_lossy(&buf[..n]).contains(" 200 ") {
                        return true;
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let handle = app.handle().clone();

            // User data goes to Tauri's per-OS application-data directory
            // (macOS ~/Library/Application Support/ai.lqivip.auteur,
            // Windows %APPDATA%\ai.lqivip.auteur, Linux ~/.local/share/
            // ai.lqivip.auteur) and reaches the server through its
            // existing AUTEUR_DATA_DIR override — never the install dir.
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;

            // The installer carries web/dist as a bundle resource; the
            // server serves it when AUTEUR_WEB_DIST points at the copy.
            let web_dist = app.path().resource_dir()?.join("web").join("dist");

            let (_rx, child) = handle
                .shell()
                .sidecar("auteur-server")?
                .env("AUTEUR_DATA_DIR", data_dir.to_string_lossy().into_owned())
                .env("AUTEUR_HOST", "127.0.0.1")
                .env("AUTEUR_PORT", SERVER_PORT.to_string())
                .env("AUTEUR_WEB_DIST", web_dist.to_string_lossy().into_owned())
                .spawn()?;
            app.manage(SidecarState(Mutex::new(Some(child))));

            if !wait_for_server(SERVER_PORT, Duration::from_secs(30)) {
                eprintln!(
                    "AUTEUR: server sidecar did not answer /api/health on port {SERVER_PORT} within 30s"
                );
            }

            let url: tauri::Url = format!("http://127.0.0.1:{SERVER_PORT}/").parse()?;
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("AUTEUR")
                .inner_size(1280.0, 800.0)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building AUTEUR")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(state) = app.try_state::<SidecarState>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(child) = guard.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        });
}
