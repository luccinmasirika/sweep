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
        .stdout(contains("caches"));
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
    assert!(parsed.get("caches").is_some());
}
