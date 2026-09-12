use anyhow::Result;

use super::Target;
use crate::config::Config;
use crate::fsutil;
use crate::report::{CleanAction, Finding, Report};

pub struct VmImages;

/// A container or VM runtime keeps its disk as one opaque image file. It grows
/// with every build and never shrinks on its own — `docker system prune` frees
/// space *inside* the image, not on the Mac — so the image has to be measured
/// and reset as a whole. All of it is re-creatable, but not for free: the note
/// says what it costs and how to do it cleanly.
struct Runtime {
    rel: &'static str,
    note: &'static str,
}

const RUNTIMES: &[Runtime] = &[
    Runtime {
        rel: ".colima",
        note: "colima VM disks — `colima delete` to reset",
    },
    Runtime {
        rel: ".lima",
        note: "lima VM disks — `limactl delete <vm>` to reset",
    },
    Runtime {
        rel: ".orbstack/data",
        note: "orbstack data — `orb reclaim` shrinks it in place",
    },
    Runtime {
        rel: "OrbStack",
        note: "orbstack machines",
    },
    Runtime {
        rel: "Library/Containers/com.docker.docker/Data/vms",
        note: "docker desktop disk image — pruning won't shrink it",
    },
    Runtime {
        rel: ".docker/desktop/vms",
        note: "docker desktop disk image",
    },
    Runtime {
        rel: ".rd",
        note: "rancher desktop VM",
    },
    Runtime {
        rel: ".local/share/containers/podman",
        note: "podman machine disks — `podman machine reset`",
    },
    Runtime {
        rel: "Library/Containers/com.utmapp.UTM/Data/Documents",
        note: "UTM virtual machines",
    },
    Runtime {
        rel: "Parallels",
        note: "parallels virtual machines",
    },
    Runtime {
        rel: "Virtual Machines.localized",
        note: "vmware virtual machines",
    },
    Runtime {
        rel: "VirtualBox VMs",
        note: "virtualbox virtual machines",
    },
];

impl Target for VmImages {
    fn name(&self) -> &'static str {
        "vm-images"
    }

    fn enabled(&self, cfg: &Config) -> bool {
        cfg.vm_images
    }

    fn scan(&self, cfg: &Config) -> Result<Report> {
        let mut report = Report::new(self.name());
        for rt in RUNTIMES {
            let path = cfg.home.join(rt.rel);
            if !path.is_dir() {
                continue;
            }
            let usage = fsutil::dir_usage(&path);
            if usage.bytes < cfg.min_dir_bytes && !usage.unreadable {
                continue;
            }
            // Deleting one of these throws away images, volumes and any VM
            // state with them, so it always takes a deliberate tick.
            report.findings.push(
                Finding::dir(path, usage.bytes, CleanAction::RemovePath)
                    .risky(true)
                    .unreadable(usage.unreadable)
                    .with_note(rt.note),
            );
        }
        report.findings.sort_by(|a, b| b.size.cmp(&a.size));
        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    #[test]
    fn finds_a_runtime_disk_and_flags_it_personal() {
        let home = tempfile::tempdir().unwrap();
        let disks = home.path().join(".colima/_lima/colima");
        fs::create_dir_all(&disks).unwrap();
        fs::write(disks.join("diffdisk"), vec![0u8; 2_000_000]).unwrap();

        let cfg = Config {
            home: home.path().to_path_buf(),
            ..Default::default()
        };
        let found = VmImages.scan(&cfg).unwrap().findings;

        assert_eq!(found.len(), 1);
        assert!(found[0].path.ends_with(".colima"));
        assert!(found[0].risky);
        assert!(found[0].size >= 2_000_000);
    }

    #[test]
    fn nothing_installed_means_nothing_reported() {
        let cfg = Config {
            home: PathBuf::from("/nonexistent-sweep-home"),
            ..Default::default()
        };
        assert!(VmImages.scan(&cfg).unwrap().findings.is_empty());
    }
}
