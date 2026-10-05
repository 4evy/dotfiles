use crate::protocol::{Failure, Result};
use std::{
    collections::HashMap,
    os::{
        fd::AsFd,
        unix::{fs::PermissionsExt, process::CommandExt},
    },
    time::Duration,
};
use zbus::zvariant::{OwnedFd, OwnedObjectPath, Value};

// Keep these signatures aligned with gnome/protocol.ts's introspection XML
#[zbus::proxy(
    interface = "io.github.fourevy.OmpWorkspaces1",
    default_service = "org.gnome.Shell",
    default_path = "/io/github/fourevy/OmpWorkspaces"
)]
trait Workspaces {
    fn inspect(&self) -> zbus::Result<String>;
    fn open(
        &self,
        id: &str,
        uri: &str,
        profile: &str,
        environment: &HashMap<String, String>,
    ) -> zbus::Result<u32>;
    fn launch(
        &self,
        id: &str,
        arguments: &[String],
        environment: &HashMap<String, String>,
        directory: &str,
        descriptors: &[OwnedFd],
    ) -> zbus::Result<u32>;
    fn status(&self, id: &str) -> zbus::Result<(bool, bool, i32)>;
    fn ready(&self, id: &str) -> zbus::Result<()>;
    fn release(&self, id: &str) -> zbus::Result<bool>;
}

#[zbus::proxy(
    interface = "org.freedesktop.systemd1.Manager",
    default_service = "org.freedesktop.systemd1",
    default_path = "/org/freedesktop/systemd1"
)]
trait SystemdManager {
    fn kill_unit(&self, unit: &str, who: &str, signal: i32) -> zbus::Result<()>;
    fn start_transient_unit(
        &self,
        unit: &str,
        mode: &str,
        properties: &[(&str, Value<'_>)],
        auxiliary: &[(&str, Vec<(&str, Value<'_>)>)],
    ) -> zbus::Result<OwnedObjectPath>;
}

pub struct Lease {
    pub id: String,
    bus: zbus::Connection,
    profile: Option<tempfile::TempDir>,
}

fn prerequisite(error: impl std::fmt::Display) -> Failure {
    Failure::new(
        "prerequisite",
        format!(
            "GNOME workspace isolation is unavailable: {error}; enable omp-workspaces@4evy.local in a GNOME 50 Wayland session with static workspaces on every monitor"
        ),
    )
}

fn scope(id: &str) -> String {
    format!("omp-gui-{id}.scope")
}

async fn manager_bus() -> Result<zbus::Connection> {
    let address = format!(
        "unix:path=/run/user/{}/bus",
        rustix::process::geteuid().as_raw()
    );
    zbus::connection::Builder::address(address.as_str())
        .map_err(prerequisite)?
        .build()
        .await
        .map_err(prerequisite)
}

pub async fn available(bus: &zbus::Connection) -> bool {
    let Ok(proxy) = WorkspacesProxy::new(bus).await else {
        return false;
    };
    proxy.inspect().await.is_ok()
}

impl Lease {
    pub async fn open(bus: zbus::Connection, uri: &str) -> Result<Self> {
        let adapter = WorkspacesProxy::new(&bus).await.map_err(prerequisite)?;
        let id = uuid::Uuid::new_v4().to_string();
        let mut profile = tempfile::Builder::new()
            .prefix("omp-gui-")
            .permissions(std::fs::Permissions::from_mode(0o700))
            .tempdir()
            .map_err(prerequisite)?;
        let helper = std::env::current_exe().map_err(prerequisite)?;
        let mut environment: HashMap<String, String> = HashMap::with_capacity(3);
        environment.insert(
            "OMP_WORKSPACE_HELPER".into(),
            helper.to_string_lossy().into_owned(),
        );
        for key in ["OMP_WORKSPACE_DBUS_CONFIG", "PATH"] {
            if let Ok(value) = std::env::var(key) {
                environment.insert(key.into(), value);
            }
        }
        let _: u32 = adapter
            .open(
                &id,
                uri,
                profile.path().to_string_lossy().as_ref(),
                &environment,
            )
            .await
            .map_err(prerequisite)?;
        // Retain a live browser's profile if stopping its scope later fails
        profile.disable_cleanup(true);
        drop(adapter);
        Self::prepared(Self {
            id,
            bus,
            profile: Some(profile),
        })
        .await
    }

    async fn launch(arguments: &[String]) -> Result<Self> {
        if arguments.is_empty() {
            return Err(Failure::new(
                "invalid-request",
                "workspace-run requires an executable",
            ));
        }
        if std::env::var_os("WAYLAND_DISPLAY").is_none() {
            return Err(prerequisite(
                "Wayland graphical-session environment is required",
            ));
        }
        let bus = zbus::Connection::session().await.map_err(prerequisite)?;
        let id = uuid::Uuid::new_v4().to_string();
        let duplicate = |fd: std::os::fd::BorrowedFd<'_>| -> Result<OwnedFd> {
            fd.try_clone_to_owned()
                .map(OwnedFd::from)
                .map_err(prerequisite)
        };
        let descriptors = vec![
            duplicate(std::io::stdin().as_fd())?,
            duplicate(std::io::stdout().as_fd())?,
            duplicate(std::io::stderr().as_fd())?,
        ];
        let mut environment: HashMap<String, String> = std::env::vars().collect();
        environment.insert(
            "OMP_WORKSPACE_HELPER".into(),
            std::env::current_exe()
                .map_err(prerequisite)?
                .to_string_lossy()
                .into_owned(),
        );
        let directory = std::env::current_dir().map_err(prerequisite)?;
        let _: u32 = WorkspacesProxy::new(&bus)
            .await
            .map_err(prerequisite)?
            .launch(
                &id,
                arguments,
                &environment,
                directory.to_string_lossy().as_ref(),
                &descriptors,
            )
            .await
            .map_err(prerequisite)?;
        Self::prepared(Self {
            id,
            bus,
            profile: None,
        })
        .await
    }

    async fn status(&self) -> Result<(bool, bool, i32)> {
        WorkspacesProxy::new(&self.bus)
            .await
            .map_err(prerequisite)?
            .status(&self.id)
            .await
            .map_err(prerequisite)
    }

    async fn prepared(lease: Self) -> Result<Self> {
        let result = async {
            for _ in 0..50 {
                let (ready, exited, status) = lease.status().await?;
                if ready {
                    return Ok(());
                }
                if exited {
                    return Err(prerequisite(format!(
                        "Scoped GUI launcher exited before isolation was ready ({status})"
                    )));
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(prerequisite(
                "Timed out waiting for the user-systemd launch scope",
            ))
        }
        .await;
        if let Err(error) = result {
            let _ = lease.release().await;
            return Err(error);
        }
        Ok(lease)
    }

    async fn signal_scope(&self, signal: i32) -> Result<()> {
        let manager = manager_bus().await?;
        match SystemdManagerProxy::new(&manager)
            .await
            .map_err(prerequisite)?
            .kill_unit(&scope(&self.id), "all", signal)
            .await
        {
            Ok(()) => Ok(()),
            Err(zbus::Error::MethodError(name, _, _))
                if matches!(
                    name.as_str(),
                    "org.freedesktop.systemd1.NoSuchUnit"
                        | "org.freedesktop.systemd1.UnitNotLoaded"
                        | "org.freedesktop.systemd1.UnitNotRunning"
                        | "org.freedesktop.systemd1.NoSuchProcess"
                ) =>
            {
                Ok(())
            }
            Err(error) => Err(prerequisite(error)),
        }
    }

    pub async fn release(self) -> Result<()> {
        // Scope identity survives forks, reparenting and new process sessions
        // Stop all descendants while pre-map routing remains installed
        self.signal_scope(15).await?;
        let proxy = WorkspacesProxy::new(&self.bus)
            .await
            .map_err(prerequisite)?;
        let mut complete = false;
        for _ in 0..20 {
            complete = proxy.release(&self.id).await.map_err(prerequisite)?;
            if complete {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        if !complete {
            self.signal_scope(9).await?;
            // Deferred cleanup never deletes a workspace with unrelated windows
            let _: bool = proxy.release(&self.id).await.map_err(prerequisite)?;
        }
        if let Some(profile) = self.profile {
            profile.close().map_err(prerequisite)?;
        }
        Ok(())
    }
}

pub async fn run(arguments: &[String]) -> Result<i32> {
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(prerequisite)?;
    let mut interrupt = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
        .map_err(prerequisite)?;
    let mut hangup = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::hangup())
        .map_err(prerequisite)?;
    let lease = Lease::launch(arguments).await?;
    let mut interval = tokio::time::interval(Duration::from_millis(100));
    let parent = rustix::process::getppid();
    let stdin = std::io::stdin();
    let mut input = [rustix::event::PollFd::new(
        &stdin,
        rustix::event::PollFlags::HUP,
    )];
    let result = loop {
        tokio::select! {
            _ = terminate.recv() => break Ok(143),
            _ = interrupt.recv() => break Ok(130),
            _ = hangup.recv() => break Ok(129),
            _ = interval.tick() => {
                if rustix::process::getppid() != parent {
                    break Ok(129);
                }
                let timeout = rustix::event::Timespec::default();
                if let Err(error) = rustix::event::poll(&mut input, Some(&timeout)) {
                    break Err(prerequisite(error));
                }
                if input[0].revents().contains(rustix::event::PollFlags::HUP) {
                    break Ok(0);
                }
                match lease.status().await {
                    Ok((_, true, status)) => break Ok(status),
                    Ok((_, false, _)) => {},
                    Err(error) => break Err(error),
                }
            },
        }
    };
    let released = lease.release().await;
    match result {
        Err(error) => Err(error),
        Ok(status) => released.map(|()| status),
    }
}

pub async fn child(id: &str, arguments: &[String]) -> Result<()> {
    uuid::Uuid::parse_str(id).map_err(prerequisite)?;
    if arguments.is_empty() {
        return Err(Failure::new(
            "invalid-request",
            "workspace-child requires an executable",
        ));
    }
    let bus = zbus::Connection::session().await.map_err(prerequisite)?;
    let unit = scope(id);
    let properties: Vec<(&str, Value<'_>)> = vec![
        ("PIDs", Value::new(vec![std::process::id()])),
        ("Description", Value::from("OMP isolated GUI launch")),
        ("CollectMode", Value::from("inactive-or-failed")),
    ];
    let auxiliary: Vec<(&str, Vec<(&str, Value<'_>)>)> = Vec::new();
    let manager = manager_bus().await?;
    let _: OwnedObjectPath = SystemdManagerProxy::new(&manager)
        .await
        .map_err(prerequisite)?
        .start_transient_unit(&unit, "fail", &properties, &auxiliary)
        .await
        .map_err(prerequisite)?;
    let mut attached = false;
    for _ in 0..50 {
        let cgroup = std::fs::read_to_string("/proc/self/cgroup").map_err(prerequisite)?;
        if cgroup.split(['/', '\n']).any(|component| component == unit) {
            attached = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if !attached {
        return Err(prerequisite("The user-systemd launch scope did not attach"));
    }
    let _: () = WorkspacesProxy::new(&bus)
        .await
        .map_err(prerequisite)?
        .ready(id)
        .await
        .map_err(prerequisite)?;
    drop(bus);
    // The session daemon closes FD 3, so its activation environment must not
    // advertise that inherited socket to portals or their GTK descendants
    let mut command = std::process::Command::new("setsid");
    command
        .env_remove("WAYLAND_SOCKET")
        .args(["--wait", "dbus-run-session"]);
    if let Some(configuration) = std::env::var_os("OMP_WORKSPACE_DBUS_CONFIG") {
        command.arg("--config-file").arg(configuration);
    }
    let error = command
        .arg("--")
        .arg(std::env::current_exe().map_err(prerequisite)?)
        .args(["workspace-app", "--"])
        .args(arguments)
        .exec();
    Err(prerequisite(error))
}

pub fn app(arguments: &[String]) -> Result<()> {
    let Some(executable) = arguments.first() else {
        return Err(Failure::new(
            "invalid-request",
            "workspace-app requires an executable",
        ));
    };
    // Only the direct native app inherits the compositor's trusted socket
    let error = std::process::Command::new(executable)
        .args(&arguments[1..])
        .env("WAYLAND_SOCKET", "3")
        .exec();
    Err(prerequisite(error))
}
