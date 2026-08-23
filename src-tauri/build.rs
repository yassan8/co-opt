fn main() {
    // Rust's Windows test harness is linked without the application manifest
    // that Tauri embeds in the normal desktop executable.  Wry imports
    // TaskDialogIndirect, which exists only in Common Controls v6; without
    // this dependency the test process exits before main with 0xc0000139.
    println!("cargo:rerun-if-env-changed=COOPT_TAURI_TEST_MANIFEST");
    #[cfg(target_os = "windows")]
    {
        if std::env::var_os("COOPT_TAURI_TEST_MANIFEST").as_deref()
            == Some(std::ffi::OsStr::new("1"))
        {
            let out_dir = std::path::PathBuf::from(
                std::env::var_os("OUT_DIR").expect("Cargo did not provide OUT_DIR"),
            );
            let manifest_path = out_dir.join("co-opt-common-controls-v6.manifest");
            std::fs::write(
                &manifest_path,
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency><dependentAssembly><assemblyIdentity
    type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0"
    processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"
  /></dependentAssembly></dependency>
</assembly>
"#,
            )
            .expect("failed to write the Windows Common Controls v6 manifest");
            println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
            println!(
                "cargo:rustc-link-arg=/MANIFESTINPUT:{}",
                manifest_path.display()
            );
        }
    }

    tauri_build::build()
}
