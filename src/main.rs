mod catalog;
mod cli;
mod config;
mod exec;
mod fsutil;
mod report;
mod targets;
mod ui;

use anyhow::Result;
use clap::Parser;

use cli::{Cli, Command};

fn main() -> Result<()> {
    let cli = Cli::parse();
    let cfg = config::Config::load(cli.config.as_deref())?;

    match cli.command {
        Command::Scan { only } => cli::run_scan(&cfg, cli.json, &only),
        Command::Clean {
            yes,
            only,
            aggressive,
            volumes,
        } => cli::run_clean(&cfg, yes, &only, aggressive, volumes),
        Command::Doctor => cli::run_doctor(cli.json),
        Command::Config => cli::run_config(&cfg, cli.json),
    }
}
