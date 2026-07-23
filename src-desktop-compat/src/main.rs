//! GrokBuild Gateway — WebView2-free / Windows 7-friendly tray shell.
//!
//! No Edge WebView2 runtime. Opens the built-in gateway WebUI in the
//! system default browser. Tray menus control start/stop/autostart.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod gateway;
#[cfg(windows)]
mod winutil;

use gateway::GatewayManager;
use muda::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use std::time::Duration;
use tao::event::{Event, StartCause};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tray_icon::{Icon, MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

#[derive(Debug, Clone)]
enum UserEvent {
    Tray(TrayIconEvent),
    Menu(muda::MenuId),
    Tick,
}

fn load_icon() -> Icon {
    // Prefer embedded ICO next to crate (copied from src-tauri/icons).
    const ICO: &[u8] = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/icon.ico"));
    if let Ok(img) = image::load_from_memory(ICO) {
        let rgba = img.to_rgba8();
        let (w, h) = rgba.dimensions();
        if let Ok(icon) = Icon::from_rgba(rgba.into_raw(), w, h) {
            return icon;
        }
    }
    // 16×16 solid blue fallback
    let mut rgba = vec![0u8; 16 * 16 * 4];
    for px in rgba.chunks_exact_mut(4) {
        px[0] = 0x5b;
        px[1] = 0x8c;
        px[2] = 0xff;
        px[3] = 0xff;
    }
    Icon::from_rgba(rgba, 16, 16).expect("fallback icon")
}

fn open_ui(gw: &GatewayManager) {
    let url = format!("{}/", gw.public_base());
    let _ = open::that(&url);
}

fn status_tooltip(gw: &GatewayManager) -> String {
    let st = gw.status();
    if st.healthy {
        format!("GrokBuild Gateway（兼容版）\n运行中 · {}", st.public_base)
    } else if st.running {
        "GrokBuild Gateway（兼容版）\n启动中…".into()
    } else {
        "GrokBuild Gateway（兼容版）\n已停止".into()
    }
}

fn main() {
    #[cfg(not(windows))]
    {
        eprintln!("gbg-desktop-compat is Windows-only.");
        std::process::exit(1);
    }

    #[cfg(windows)]
    {
        run_windows();
    }
}

#[cfg(windows)]
fn run_windows() {
    // Single instance
    let mutex = match winutil::acquire_single_instance() {
        Ok(h) => h,
        Err(()) => {
            // Another instance is already running — best-effort open UI if gateway is up
            let port: u16 = std::env::var("GBG_PORT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(8787);
            let _ = open::that(format!("http://127.0.0.1:{}/", port));
            return;
        }
    };

    let port: u16 = std::env::var("GBG_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8787);

    std::env::set_var("NO_PROXY", "127.0.0.1,localhost,::1,0.0.0.0");
    std::env::set_var("no_proxy", "127.0.0.1,localhost,::1,0.0.0.0");

    let gateway = GatewayManager::new(port);
    let exe = winutil::exe_dir();
    let _ = GatewayManager::ensure_embedded_gbg();

    let no_auto_gw = std::env::args().any(|a| a == "--no-gateway");
    let autostart_arg = std::env::args().any(|a| a == "--autostart");
    let open_on_start =
        !autostart_arg && !std::env::args().any(|a| a == "--minimized" || a == "--no-open");

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    // Forward tray / menu events into the event loop (must be set before tray build on some platforms)
    let proxy_tray = proxy.clone();
    TrayIconEvent::set_event_handler(Some(move |event| {
        let _ = proxy_tray.send_event(UserEvent::Tray(event));
    }));
    let proxy_menu = proxy.clone();
    MenuEvent::set_event_handler(Some(move |event: muda::MenuEvent| {
        let _ = proxy_menu.send_event(UserEvent::Menu(event.id));
    }));

    // Periodic tooltip refresh
    let proxy_tick = proxy.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(4));
        if proxy_tick.send_event(UserEvent::Tick).is_err() {
            break;
        }
    });

    let show_i = MenuItem::with_id("open_ui", "打开 WebUI", true, None);
    let start_i = MenuItem::with_id("start", "启动网关", true, None);
    let stop_i = MenuItem::with_id("stop", "停止网关", true, None);
    let auto_i = CheckMenuItem::with_id(
        "autostart",
        "开机自启",
        true,
        winutil::is_autostart_enabled(),
        None,
    );
    let about_i = MenuItem::with_id("about", "关于兼容版…", true, None);
    let quit_i = MenuItem::with_id("quit", "退出", true, None);

    let menu = Menu::new();
    let _ = menu.append(&show_i);
    let _ = menu.append(&PredefinedMenuItem::separator());
    let _ = menu.append(&start_i);
    let _ = menu.append(&stop_i);
    let _ = menu.append(&PredefinedMenuItem::separator());
    let _ = menu.append(&auto_i);
    let _ = menu.append(&about_i);
    let _ = menu.append(&PredefinedMenuItem::separator());
    let _ = menu.append(&quit_i);

    let icon = load_icon();
    let tray = TrayIconBuilder::new()
        .with_menu(Box::new(menu))
        .with_tooltip("GrokBuild Gateway（兼容版 · 无 WebView2）")
        .with_icon(icon)
        .build()
        .expect("create tray icon");

    // Auto-start gateway
    if !no_auto_gw {
        let dir = exe.clone();
        let gw2 = gateway.clone();
        let open = open_on_start;
        std::thread::spawn(move || {
            match gw2.start(&dir) {
                Ok(st) if st.healthy && open => {
                    open_ui(&gw2);
                }
                Ok(_) => {}
                Err(e) => {
                    // Tray tooltip will show stopped; message box on failure is heavy — keep quiet
                    let _ = e;
                }
            }
        });
    }

    let gw = gateway.clone();
    let exe_for_menu = exe.clone();

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            Event::NewEvents(StartCause::Init) => {
                let _ = tray.set_tooltip(Some(status_tooltip(&gw)));
            }
            Event::UserEvent(UserEvent::Tick) => {
                let _ = tray.set_tooltip(Some(status_tooltip(&gw)));
            }
            Event::UserEvent(UserEvent::Tray(TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            })) => {
                if !gw.probe_health() {
                    let _ = gw.start(&exe_for_menu);
                }
                if gw.probe_health() {
                    open_ui(&gw);
                }
            }
            Event::UserEvent(UserEvent::Menu(id)) => {
                let id = id.as_ref();
                match id {
                    "open_ui" => {
                        if !gw.probe_health() {
                            let _ = gw.start(&exe_for_menu);
                        }
                        if gw.probe_health() {
                            open_ui(&gw);
                        }
                    }
                    "start" => {
                        let _ = gw.start(&exe_for_menu);
                        if gw.probe_health() {
                            open_ui(&gw);
                        }
                        let _ = tray.set_tooltip(Some(status_tooltip(&gw)));
                    }
                    "stop" => {
                        let _ = gw.stop();
                        let _ = tray.set_tooltip(Some(status_tooltip(&gw)));
                    }
                    "autostart" => {
                        let next = !winutil::is_autostart_enabled();
                        if winutil::set_autostart(next).is_ok() {
                            auto_i.set_checked(next);
                        }
                    }
                    "about" => {
                        show_about(port);
                    }
                    "quit" => {
                        let _ = gw.stop();
                        winutil::release_single_instance(mutex);
                        *control_flow = ControlFlow::Exit;
                    }
                    _ => {}
                }
            }
            Event::LoopDestroyed => {
                let _ = gw.stop();
                winutil::release_single_instance(mutex);
            }
            _ => {}
        }
    });
}

#[cfg(windows)]
fn show_about(port: u16) {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONINFORMATION, MB_OK};

    let title: Vec<u16> = OsStr::new("GrokBuild Gateway 兼容版")
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let body = format!(
        "GrokBuild Gateway 桌面兼容版\n\n\
     · 不依赖 WebView2 / Edge 运行时\n\
     · 支持 Windows 7 及以上\n\
     · WebUI 使用系统默认浏览器打开\n\
     · 内置网关：http://127.0.0.1:{port}/\n\n\
     托盘：左键打开 WebUI · 右键菜单控制启停",
        port = port
    );
    let text: Vec<u16> = OsStr::new(&body)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONINFORMATION,
        );
    }
}
