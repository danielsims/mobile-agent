use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ServiceInfo {
    port: u16,
    token: String,
}

struct ServiceState {
    info: Option<ServiceInfo>,
    child: Option<tokio::process::Child>,
}

#[tauri::command]
fn get_service_info(state: tauri::State<'_, Mutex<ServiceState>>) -> Result<ServiceInfo, String> {
    let guard = state.lock().map_err(|e| e.to_string())?;
    guard
        .info
        .clone()
        .ok_or_else(|| "Service not ready yet".to_string())
}

#[tauri::command]
fn get_service_status(state: tauri::State<'_, Mutex<ServiceState>>) -> bool {
    let guard = state.lock().unwrap();
    guard.child.is_some()
}

pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(ServiceState {
            info: None,
            child: None,
        }))
        .invoke_handler(tauri::generate_handler![get_service_info, get_service_status])
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = start_service(&handle).await {
                    eprintln!("Failed to start service: {}", e);
                    let _ = handle.emit("service-crashed", e.to_string());
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let app = window.app_handle();
                if let Some(state) = app.try_state::<Mutex<ServiceState>>() {
                    if let Ok(mut guard) = state.lock() {
                        if let Some(ref mut child) = guard.child {
                            let _ = child.start_kill();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

async fn start_service(handle: &tauri::AppHandle) -> Result<(), String> {
    use tokio::io::{AsyncBufReadExt, BufReader};

    let token = uuid::Uuid::new_v4().to_string();

    // Resolve the service path relative to the repo root
    // In dev, we're in desktop/src-tauri, so service is at ../../service
    // We use the CARGO_MANIFEST_DIR at compile time to find the repo root
    let service_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent() // desktop/
        .and_then(|p| p.parent()) // repo root
        .map(|p| p.join("service"))
        .ok_or("Could not resolve service directory")?;

    let launcher = service_dir.join("src").join("launcher.js");
    if !launcher.exists() {
        return Err(format!(
            "Service launcher not found at {}",
            launcher.display()
        ));
    }

    let mut child = tokio::process::Command::new("node")
        .arg(&launcher)
        .arg("--headless")
        .arg(format!("--desktop-token={}", token))
        .current_dir(&service_dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Failed to spawn service: {}", e))?;

    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to capture service stdout")?;
    let mut reader = BufReader::new(stdout).lines();

    // Read stdout lines looking for the ready event
    let mut port: u16 = 3001;
    let timeout = tokio::time::timeout(std::time::Duration::from_secs(15), async {
        while let Ok(Some(line)) = reader.next_line().await {
            eprintln!("[service] {}", line);
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&line) {
                if parsed.get("event").and_then(|v| v.as_str()) == Some("ready") {
                    if let Some(p) = parsed.get("port").and_then(|v| v.as_u64()) {
                        port = p as u16;
                    }
                    return Ok(());
                }
            }
        }
        Err("Service exited before ready".to_string())
    })
    .await;

    match timeout {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(e),
        Err(_) => return Err("Service startup timed out after 15s".to_string()),
    }

    let info = ServiceInfo {
        port,
        token: token.clone(),
    };

    // Keep draining stdout in the background so the service doesn't get
    // a broken-pipe when it writes to stdout after the ready event.
    tauri::async_runtime::spawn(async move {
        while let Ok(Some(line)) = reader.next_line().await {
            eprintln!("[service] {}", line);
        }
    });

    // Store the child process and info
    {
        let state = handle.state::<Mutex<ServiceState>>();
        let mut guard = state.lock().map_err(|e| e.to_string())?;
        guard.info = Some(info);
        guard.child = Some(child);
    }

    let _ = handle.emit("service-ready", port);

    // Spawn a task to watch for the child exiting unexpectedly
    let handle_clone = handle.clone();
    tauri::async_runtime::spawn(async move {
        let child_opt = {
            let state = handle_clone.state::<Mutex<ServiceState>>();
            let mut guard = state.lock().unwrap();
            guard.child.take()
        };

        if let Some(mut child) = child_opt {
            let status = child.wait().await;
            eprintln!("[service] Process exited: {:?}", status);

            {
                let state = handle_clone.state::<Mutex<ServiceState>>();
                let mut guard = state.lock().unwrap();
                guard.info = None;
                guard.child = None;
            }

            let _ = handle_clone.emit(
                "service-crashed",
                format!("Service exited: {:?}", status),
            );
        }
    });

    Ok(())
}
