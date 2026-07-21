use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
  tauri_build::build();

  // Embed the gateway binary so gbg-desktop is self-contained (no sidecar folder).
  let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
  let repo_gbg = manifest_dir.join("..").join("release").join("gbg.exe");
  let embed_dir = manifest_dir.join("embedded");
  let embed_gbg = embed_dir.join("gbg.exe");

  println!("cargo:rerun-if-changed={}", repo_gbg.display());
  println!("cargo:rerun-if-changed={}", embed_gbg.display());

  if !repo_gbg.is_file() {
    panic!(
      "\n\n  Missing gateway binary for embedding:\n    {}\n\n  Build it first:\n    npm run build:exe\n\n",
      repo_gbg.display()
    );
  }

  fs::create_dir_all(&embed_dir).expect("create embedded/");
  // Always refresh from release/ so desktop tracks the latest gateway
  if needs_copy(&repo_gbg, &embed_gbg) {
    fs::copy(&repo_gbg, &embed_gbg).expect("copy gbg.exe into src-tauri/embedded/");
    println!("cargo:warning=embedded gateway from {}", repo_gbg.display());
  }

  // Stamp version for runtime re-extract checks
  let version = env::var("CARGO_PKG_VERSION").unwrap_or_else(|_| "0.0.0".into());
  fs::write(embed_dir.join("VERSION"), version.trim()).ok();
}

fn needs_copy(src: &Path, dst: &Path) -> bool {
  if !dst.is_file() {
    return true;
  }
  let Ok(s) = fs::metadata(src) else {
    return true;
  };
  let Ok(d) = fs::metadata(dst) else {
    return true;
  };
  s.len() != d.len()
    || s.modified().ok() != d.modified().ok()
}
