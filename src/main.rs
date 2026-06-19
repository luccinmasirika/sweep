use std::process::ExitCode;

use anyhow::Result;
use clap::Parser;

use sweep::cli::{self, Cli, Command};
use sweep::{config, dupes, explore, maintenance, schedule, smart, uninstall};

fn main() -> ExitCode {
    match run(Cli::parse()) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("Error: {e:?}");
            ExitCode::FAILURE
        }
    }
}

fn run(cli: Cli) -> Result<ExitCode> {
    let cfg = config::Config::load(cli.config.as_deref())?;

    match cli.command {
        Command::Scan { only } => {
            cli::run_scan(&cfg, cli.json, &only)?;
            Ok(ExitCode::SUCCESS)
        }
        Command::Clean {
            yes,
            only,
            aggressive,
            volumes,
            purge,
        } => {
            let failures = cli::run_clean(&cfg, yes, &only, aggressive, volumes, purge)?;
            Ok(if failures > 0 {
                ExitCode::FAILURE
            } else {
                ExitCode::SUCCESS
            })
        }
        Command::Explore { path } => {
            explore::run(path, cli.json)?;
            Ok(ExitCode::SUCCESS)
        }
        Command::Dupes { path } => {
            dupes::run(path, cli.json)?;
            Ok(ExitCode::SUCCESS)
        }
        Command::Uninstall { apps, purge } => {
            let failures = uninstall::run(apps, cli.json, purge)?;
            Ok(if failures > 0 {
                ExitCode::FAILURE
            } else {
                ExitCode::SUCCESS
            })
        }
        Command::Doctor { fix } => {
            let failures = cli::run_doctor(cli.json, fix)?;
            Ok(if failures > 0 {
                ExitCode::FAILURE
            } else {
                ExitCode::SUCCESS
            })
        }
        Command::Maintenance { fix } => {
            let failures = maintenance::run(fix)?;
            Ok(if failures > 0 {
                ExitCode::FAILURE
            } else {
                ExitCode::SUCCESS
            })
        }
        Command::Smart { yes, purge } => {
            let failures = smart::run(&cfg, yes, purge)?;
            Ok(if failures > 0 {
                ExitCode::FAILURE
            } else {
                ExitCode::SUCCESS
            })
        }
        Command::Schedule { action, interval } => {
            let failures = schedule::run(action, interval)?;
            Ok(if failures > 0 {
                ExitCode::FAILURE
            } else {
                ExitCode::SUCCESS
            })
        }
        Command::Config => {
            cli::run_config(&cfg, cli.json)?;
            Ok(ExitCode::SUCCESS)
        }
    }
}
