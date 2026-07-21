#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod gateway;

use gateway::GatewayManager;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{
  menu::{Menu, MenuItem},
  tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
  AppHandle, Manager, RunEvent, State, WindowEvent,
};
use tauri_plugin_autostart::MacosLauncher;

struct AppState {
  gateway: Arc<GatewayManager>,
  exe_dir: PathBuf,
}

fn exe_dir() -> PathBuf {
  std::env::current_exe()
    .ok()
    .and_then(|p| p.parent().map(|d| d.to_path_buf()))
    .unwrap_or_else(|| PathBuf::from("."))
}

#[tauri::command]
fn gateway_status(state: State<'_, AppState>) -> gateway::GatewayStatus {
  state.gateway.status()
}

#[tauri::command]
fn gateway_start(state: State<'_, AppState>) -> Result<gateway::GatewayStatus, String> {
  state.gateway.start(&state.exe_dir)
}

#[tauri::command]
fn gateway_stop(state: State<'_, AppState>) -> Result<gateway::GatewayStatus, String> {
  state.gateway.stop()
}

#[tauri::command]
fn open_gateway_ui(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
  let url = state.gateway.public_base();
  if let Some(win) = app.get_webview_window("main") {
    win
      .eval(&format!(
        "window.location.replace({})",
        serde_json::to_string(&url).unwrap()
      ))
      .map_err(|e| e.to_string())?;
    let _ = win.show();
    let _ = win.set_focus();
  }
  Ok(())
}

#[tauri::command]
fn open_shell(app: AppHandle) -> Result<(), String> {
  if let Some(win) = app.get_webview_window("main") {
    win
      .eval("window.location.replace('/')")
      .map_err(|e| e.to_string())?;
    let _ = win.show();
    let _ = win.set_focus();
  }
  Ok(())
}

fn show_main(app: &AppHandle) {
  if let Some(win) = app.get_webview_window("main") {
    let _ = win.show();
    let _ = win.set_focus();
  }
}

fn navigate_to_gateway(app: &AppHandle, gw: &GatewayManager) {
  let url = gw.public_base();
  if let Some(win) = app.get_webview_window("main") {
    let _ = win.eval(&format!(
      "window.location.replace({})",
      serde_json::to_string(&url).unwrap()
    ));
    let _ = win.show();
  }
}

fn main() {
  let port: u16 = std::env::var("GBG_PORT")
    .ok()
    .and_then(|s| s.parse().ok())
    .unwrap_or(8787);

  // Apply process-level loopback protection for the shell itself
  std::env::set_var("NO_PROXY", "127.0.0.1,localhost,::1,0.0.0.0");
  std::env::set_var("no_proxy", "127.0.0.1,localhost,::1,0.0.0.0");

  let gateway = GatewayManager::new(port);
  let exe = exe_dir();

  // Pre-extract embedded gateway ASAP (fails early if corrupt)
  let _ = GatewayManager::ensure_embedded_gbg();

  tauri::Builder::default()
    .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
      show_main(app);
    }))
    .plugin(tauri_plugin_autostart::init(
      MacosLauncher::LaunchAgent,
      Some(vec!["--autostart"]),
    ))
    .manage(AppState {
      gateway: gateway.clone(),
      exe_dir: exe.clone(),
    })
    .invoke_handler(tauri::generate_handler![
      gateway_status,
      gateway_start,
      gateway_stop,
      open_gateway_ui,
      open_shell,
    ])
    .setup(move |app| {
      let handle = app.handle().clone();

      if let Some(win) = app.get_webview_window("main") {
        let h = handle.clone();
        win.on_window_event(move |event| {
          if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if let Some(w) = h.get_webview_window("main") {
              let _ = w.hide();
            }
          }
        });
      }

      let show_i = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
      let start_i = MenuItem::with_id(app, "start", "启动网关", true, None::<&str>)?;
      let stop_i = MenuItem::with_id(app, "stop", "停止网关", true, None::<&str>)?;
      let open_i = MenuItem::with_id(app, "open_ui", "打开 WebUI", true, None::<&str>)?;
      let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
      let menu = Menu::with_items(app, &[&show_i, &start_i, &stop_i, &open_i, &quit_i])?;

      let gw = gateway.clone();
      let exe_for_tray = exe.clone();
      let _tray = TrayIconBuilder::new()
        .icon(app.default_window_icon().unwrap().clone())
        .menu(&menu)
        .tooltip("GrokBuild Gateway（内置网关）")
        .on_menu_event(move |app, event| match event.id.as_ref() {
          "show" => show_main(app),
          "start" => {
            let _ = gw.start(&exe_for_tray);
            if gw.probe_health() {
              navigate_to_gateway(app, &gw);
            } else {
              show_main(app);
            }
          }
          "stop" => {
            let _ = gw.stop();
            show_main(app);
          }
          "open_ui" => {
            if gw.probe_health() {
              navigate_to_gateway(app, &gw);
            } else {
              let _ = gw.start(&exe_dir());
              if gw.probe_health() {
                navigate_to_gateway(app, &gw);
              } else {
                show_main(app);
              }
            }
          }
          "quit" => {
            let _ = gw.stop();
            app.exit(0);
          }
          _ => {}
        })
        .on_tray_icon_event(|tray, event| {
          if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
          } = event
          {
            show_main(tray.app_handle());
          }
        })
        .build(app)?;

      let autostart = std::env::args().any(|a| a == "--autostart");
      let minimized = std::env::args().any(|a| a == "--minimized" || a == "--autostart");
      let no_auto_gw = std::env::args().any(|a| a == "--no-gateway");

      if minimized {
        if let Some(win) = app.get_webview_window("main") {
          let _ = win.hide();
        }
      }

      // Built-in gateway: auto-start unless explicitly disabled
      if !no_auto_gw {
        let dir = exe.clone();
        let gw2 = gateway.clone();
        let app_h = handle.clone();
        std::thread::spawn(move || {
          match gw2.start(&dir) {
            Ok(st) if st.healthy => {
              // Navigate main window to live WebUI
              let url = gw2.public_base();
              let _ = app_h.get_webview_window("main").map(|win| {
                let _ = win.eval(&format!(
                  "window.location.replace({})",
                  serde_json::to_string(&url).unwrap()
                ));
              });
            }
            _ => {}
          }
        });
      }

      let _ = autostart;
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building gbg-desktop")
    .run(|_app_handle, event| {
      if let RunEvent::Exit = event {
        // best-effort: nothing else
      }
    });
}
