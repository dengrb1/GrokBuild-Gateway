//! Built-in gateway: extract embedded gbg.exe and manage its lifecycle.
//! Health probes always use 127.0.0.1 and never system proxy.
//! Shared logic with the Tauri desktop shell (no WebView dependency).

use parking_lot::Mutex;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

/// Gateway binary baked into the desktop client at compile time.
static EMBEDDED_GBG: &[u8] =
    include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/embedded/gbg.exe"));
static EMBEDDED_VERSION: &str =
    include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/embedded/VERSION"));

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayStatus {
    pub running: bool,
    pub healthy: bool,
    pub port: u16,
    pub public_base: String,
    pub pid: Option<u32>,
    pub last_error: Option<String>,
    pub gbg_path: Option<String>,
    pub embedded: bool,
}

pub struct GatewayManager {
    inner: Mutex<Inner>,
    port: u16,
}

struct Inner {
    child: Option<Child>,
    last_error: Option<String>,
    gbg_path: Option<PathBuf>,
}

impl GatewayManager {
    pub fn new(port: u16) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                child: None,
                last_error: None,
                gbg_path: None,
            }),
            port,
        })
    }

    pub fn public_base(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// `%LOCALAPPDATA%\GrokBuild-Gateway\runtime\` (or `~/.gbg/runtime` fallback)
    pub fn runtime_dir() -> PathBuf {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            return PathBuf::from(local)
                .join("GrokBuild-Gateway")
                .join("runtime");
        }
        if let Ok(home) = std::env::var("USERPROFILE") {
            return PathBuf::from(home).join(".gbg").join("runtime");
        }
        std::env::temp_dir().join("gbg-runtime")
    }

    /// Extract embedded gbg.exe if missing or version stamp differs.
    pub fn ensure_embedded_gbg() -> Result<PathBuf, String> {
        let dir = Self::runtime_dir();
        fs::create_dir_all(&dir).map_err(|e| format!("create runtime dir failed: {e}"))?;

        let version = EMBEDDED_VERSION.trim();
        let stamp = dir.join("VERSION");
        let exe = dir.join("gbg.exe");

        let need_write = !exe.is_file()
            || fs::read_to_string(&stamp)
                .map(|s| s.trim() != version)
                .unwrap_or(true)
            || fs::metadata(&exe)
                .map(|m| m.len() as usize != EMBEDDED_GBG.len())
                .unwrap_or(true);

        if need_write {
            let tmp = dir.join("gbg.exe.tmp");
            {
                let mut f = fs::File::create(&tmp).map_err(|e| format!("write gbg tmp: {e}"))?;
                f.write_all(EMBEDDED_GBG)
                    .map_err(|e| format!("write gbg bytes: {e}"))?;
                f.sync_all().ok();
            }
            if exe.exists() {
                let _ = fs::remove_file(&exe);
            }
            if let Err(e) = fs::rename(&tmp, &exe) {
                fs::copy(&tmp, &exe)
                    .map_err(|e2| format!("install embedded gbg failed: {e} / {e2}"))?;
                let _ = fs::remove_file(&tmp);
            }
            if !exe.is_file() {
                return Err("embedded gbg extract produced no file".into());
            }
            fs::write(&stamp, version).map_err(|e| format!("write VERSION: {e}"))?;
        }

        Ok(exe)
    }

    /// Prefer built-in extracted binary; optional external override via GBG_EXE / same-folder.
    pub fn resolve_gbg(exe_dir: &Path) -> Result<PathBuf, String> {
        if let Ok(p) = std::env::var("GBG_EXE") {
            let path = PathBuf::from(p);
            if path.is_file() {
                return Ok(path);
            }
        }

        let external = [
            exe_dir.join("gbg.exe"),
            exe_dir.join("resources").join("gbg.exe"),
            PathBuf::from("release/gbg.exe"),
        ];
        if std::env::var("GBG_USE_EXTERNAL").ok().as_deref() == Some("1") {
            for c in &external {
                if c.is_file() {
                    return Ok(c.clone());
                }
            }
        }

        Self::ensure_embedded_gbg()
    }

    pub fn status(&self) -> GatewayStatus {
        let mut guard = self.inner.lock();
        if let Some(child) = guard.child.as_mut() {
            match child.try_wait() {
                Ok(Some(status)) => {
                    guard.last_error = Some(format!("gateway exited: {status}"));
                    guard.child = None;
                }
                Ok(None) => {}
                Err(e) => {
                    guard.last_error = Some(e.to_string());
                    guard.child = None;
                }
            }
        }
        let pid = guard.child.as_ref().map(|c| c.id());
        let gbg_path = guard
            .gbg_path
            .clone()
            .or_else(|| Self::ensure_embedded_gbg().ok());
        drop(guard);

        let healthy = self.probe_health();
        let running = pid.is_some() || healthy;
        let guard = self.inner.lock();
        GatewayStatus {
            running,
            healthy,
            port: self.port,
            public_base: self.public_base(),
            pid,
            last_error: guard.last_error.clone(),
            gbg_path: gbg_path.map(|p| p.display().to_string()),
            embedded: true,
        }
    }

    /// Health check always hits 127.0.0.1 — never localhost — and never uses system proxy.
    pub fn probe_health(&self) -> bool {
        let url = format!("http://127.0.0.1:{}/api/health", self.port);
        let client = match reqwest::blocking::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()
        {
            Ok(c) => c,
            Err(_) => return false,
        };
        match client.get(&url).send() {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(v) = resp.json::<serde_json::Value>() {
                    v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false)
                } else {
                    true
                }
            }
            _ => false,
        }
    }

    pub fn start(&self, exe_dir: &Path) -> Result<GatewayStatus, String> {
        if self.probe_health() {
            let gbg = Self::resolve_gbg(exe_dir).ok();
            if let Some(p) = gbg {
                self.inner.lock().gbg_path = Some(p);
            }
            return Ok(self.status());
        }

        {
            let mut guard = self.inner.lock();
            if let Some(child) = guard.child.as_mut() {
                if let Ok(None) = child.try_wait() {
                    drop(guard);
                    return Ok(self.status());
                }
            }
        }

        let gbg = Self::resolve_gbg(exe_dir)?;

        let mut cmd = Command::new(&gbg);
        cmd.arg("serve")
            .arg("--port")
            .arg(self.port.to_string())
            .arg("--host")
            .arg("127.0.0.1")
            .current_dir(gbg.parent().unwrap_or(exe_dir))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        cmd.env("NO_PROXY", "127.0.0.1,localhost,::1,0.0.0.0");
        cmd.env("no_proxy", "127.0.0.1,localhost,::1,0.0.0.0");
        cmd.env_remove("HTTP_PROXY");
        cmd.env_remove("HTTPS_PROXY");
        cmd.env_remove("ALL_PROXY");
        cmd.env_remove("http_proxy");
        cmd.env_remove("https_proxy");
        cmd.env_remove("all_proxy");

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("启动内置网关失败: {e} ({})", gbg.display()))?;

        if let Some(out) = child.stdout.take() {
            thread::spawn(move || {
                let reader = BufReader::new(out);
                for _ in reader.lines() {}
            });
        }
        if let Some(err) = child.stderr.take() {
            thread::spawn(move || {
                let reader = BufReader::new(err);
                for _ in reader.lines() {}
            });
        }

        {
            let mut guard = self.inner.lock();
            guard.gbg_path = Some(gbg);
            guard.child = Some(child);
            guard.last_error = None;
        }

        for _ in 0..50 {
            thread::sleep(Duration::from_millis(150));
            if self.probe_health() {
                return Ok(self.status());
            }
            let mut guard = self.inner.lock();
            if let Some(c) = guard.child.as_mut() {
                if let Ok(Some(st)) = c.try_wait() {
                    guard.child = None;
                    let msg = format!("gateway exited early: {st}");
                    guard.last_error = Some(msg.clone());
                    return Err(msg);
                }
            }
        }

        if !self.probe_health() {
            let mut guard = self.inner.lock();
            guard.last_error = Some("gateway started but health check timed out".into());
        }
        Ok(self.status())
    }

    pub fn stop(&self) -> Result<GatewayStatus, String> {
        let mut guard = self.inner.lock();
        if let Some(mut child) = guard.child.take() {
            let _ = child.kill();
            let _ = child.wait();
            guard.last_error = None;
        } else if self.probe_health() {
            guard.last_error = Some(
                "网关在运行但不是本客户端拉起的进程；请关闭占用 8787 的 gbg，或重启后再试".into(),
            );
        }
        drop(guard);

        for _ in 0..20 {
            if !self.probe_health() {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
        Ok(self.status())
    }
}
