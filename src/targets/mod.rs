use anyhow::Result;

use crate::config::Config;
use crate::report::Report;

pub mod caches;
pub mod dev_tools;
pub mod large_files;
pub mod node_modules;

pub trait Target {
    fn name(&self) -> &'static str;
    fn enabled(&self, cfg: &Config) -> bool;
    fn scan(&self, cfg: &Config) -> Result<Report>;
}

pub fn all() -> Vec<Box<dyn Target>> {
    vec![
        Box::new(caches::Caches),
        Box::new(dev_tools::DevTools),
        Box::new(large_files::LargeFiles),
        Box::new(node_modules::NodeModules),
    ]
}
