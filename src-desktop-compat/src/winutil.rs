//! Windows helpers: single-instance mutex + Run-key autostart.
//! Uses only Win7-available APIs (CreateMutex / Reg* / ShellExecute via `open`).

#![cfg(windows)]

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE};
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW,
    HKEY, HKEY_CURRENT_USER, KEY_READ, KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ,
};
use windows_sys::Win32::System::Threading::CreateMutexW;

const MUTEX_NAME: &str = "Local\\GrokBuildGatewayDesktopCompat";
const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE: &str = "GrokBuild Gateway Compat";

fn wide(s: &str) -> Vec<u16> {
    OsStr::new(s)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect()
}

/// Returns Ok(handle) if we own the single instance. Err if another instance is running.
pub fn acquire_single_instance() -> Result<HANDLE, ()> {
    let name = wide(MUTEX_NAME);
    unsafe {
        let handle = CreateMutexW(std::ptr::null(), 0, name.as_ptr());
        if handle.is_null() {
            return Err(());
        }
        if GetLastError() == ERROR_ALREADY_EXISTS {
            CloseHandle(handle);
            return Err(());
        }
        Ok(handle)
    }
}

pub fn release_single_instance(handle: HANDLE) {
    if !handle.is_null() {
        unsafe {
            CloseHandle(handle);
        }
    }
}

fn exe_path_string() -> Result<String, String> {
    let p = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(p.display().to_string())
}

/// Whether this exe is registered under HKCU Run (with --autostart).
pub fn is_autostart_enabled() -> bool {
    let path = match exe_path_string() {
        Ok(p) => p,
        Err(_) => return false,
    };
    let expected = format!("\"{}\" --autostart", path);
    let value = match read_run_value() {
        Some(v) => v,
        None => return false,
    };
    normalize_cmd(&value) == normalize_cmd(&expected)
}

fn normalize_cmd(s: &str) -> String {
    s.trim()
        .trim_matches('"')
        .replace('/', "\\")
        .to_ascii_lowercase()
}

fn read_run_value() -> Option<String> {
    let sub = wide(RUN_KEY);
    let name = wide(RUN_VALUE);
    unsafe {
        let mut hkey: HKEY = std::ptr::null_mut();
        let rc = RegOpenKeyExW(HKEY_CURRENT_USER, sub.as_ptr(), 0, KEY_READ, &mut hkey);
        if rc != 0 {
            return None;
        }
        let mut ty = 0u32;
        let mut size = 0u32;
        let q = RegQueryValueExW(
            hkey,
            name.as_ptr(),
            std::ptr::null_mut(),
            &mut ty,
            std::ptr::null_mut(),
            &mut size,
        );
        if q != 0 || size == 0 {
            RegCloseKey(hkey);
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        let q2 = RegQueryValueExW(
            hkey,
            name.as_ptr(),
            std::ptr::null_mut(),
            &mut ty,
            buf.as_mut_ptr(),
            &mut size,
        );
        RegCloseKey(hkey);
        if q2 != 0 {
            return None;
        }
        if ty != REG_SZ {
            return None;
        }
        let u16s: Vec<u16> = buf
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .take_while(|&c| c != 0)
            .collect();
        String::from_utf16(&u16s).ok()
    }
}

pub fn set_autostart(enable: bool) -> Result<(), String> {
    let sub = wide(RUN_KEY);
    let name = wide(RUN_VALUE);
    unsafe {
        let mut hkey: HKEY = std::ptr::null_mut();
        let mut disposition = 0u32;
        let rc = RegCreateKeyExW(
            HKEY_CURRENT_USER,
            sub.as_ptr(),
            0,
            std::ptr::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE | KEY_READ,
            std::ptr::null(),
            &mut hkey,
            &mut disposition,
        );
        if rc != 0 {
            return Err(format!("RegCreateKeyEx failed: {rc}"));
        }
        let result = if enable {
            let path = exe_path_string()?;
            let cmd = format!("\"{}\" --autostart", path);
            let data = wide(&cmd);
            let bytes = std::slice::from_raw_parts(data.as_ptr() as *const u8, data.len() * 2);
            let s = RegSetValueExW(
                hkey,
                name.as_ptr(),
                0,
                REG_SZ,
                bytes.as_ptr(),
                bytes.len() as u32,
            );
            if s != 0 {
                Err(format!("RegSetValueEx failed: {s}"))
            } else {
                Ok(())
            }
        } else {
            let d = RegDeleteValueW(hkey, name.as_ptr());
            // ERROR_FILE_NOT_FOUND = 2 — already absent is fine
            if d != 0 && d != 2 {
                Err(format!("RegDeleteValue failed: {d}"))
            } else {
                Ok(())
            }
        };
        RegCloseKey(hkey);
        result
    }
}

pub fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}
