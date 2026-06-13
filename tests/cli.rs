use std::fs;

use assert_cmd::Command;
use predicates::str::contains;

#[test]
fn help_mentions_cleanup() {
    Command::cargo_bin("sweep")
        .unwrap()
        .arg("--help")
        .assert()
        .success()
        .stdout(contains("cleanup"));
}

#[test]
fn config_prints_toml() {
    Command::cargo_bin("sweep")
        .unwrap()
        .arg("config")
        .assert()
        .success()
        .stdout(contains("system_caches"));
}

#[test]
fn config_json_is_valid() {
    let output = Command::cargo_bin("sweep")
        .unwrap()
        .args(["--json", "config"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let parsed: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(parsed.get("projects").is_some());
}

// Proves detection is driven by the configured home, not the real machine.
#[test]
fn scan_detects_projects_under_configured_home() {
    let home = tempfile::tempdir().unwrap();
    let nm = home.path().join("anywhere/myproj/node_modules");
    fs::create_dir_all(&nm).unwrap();
    fs::write(nm.join("blob"), vec![0u8; 2_000_000]).unwrap();

    let cfg = home.path().join("sweep.toml");
    fs::write(&cfg, format!("home = {:?}\n", home.path())).unwrap();

    let output = Command::cargo_bin("sweep")
        .unwrap()
        .args([
            "--config",
            cfg.to_str().unwrap(),
            "--json",
            "scan",
            "--only",
            "projects",
        ])
        .output()
        .unwrap();
    assert!(output.status.success());

    let reports: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let findings = reports[0]["findings"].as_array().unwrap();
    assert_eq!(findings.len(), 1);
    assert!(findings[0]["path"]
        .as_str()
        .unwrap()
        .starts_with(home.path().to_str().unwrap()));
}
