fn main() {
    // Embed the target triple so the sidecar resolver can find pi-<triple>
    // built by sidecar/build.sh during development.
    println!(
        "cargo:rustc-env=TARGET_TRIPLE={}",
        std::env::var("TARGET").unwrap_or_default()
    );
    tauri_build::build();
}
