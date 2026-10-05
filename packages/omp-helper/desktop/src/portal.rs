use crate::{
    capture, direct,
    eis::Eis,
    protocol::{Failure, Result, Source},
};
use ashpd::desktop::{
    PersistMode, Session,
    clipboard::Clipboard,
    remote_desktop::{DeviceType, RemoteDesktop, SelectDevicesOptions},
    screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType, Stream},
};
use futures_util::StreamExt;
use std::{
    os::unix::fs::DirBuilderExt,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

pub const APP_ID: &str = "io.github.fourevy.OmpHelper";

pub async fn connection() -> Result<zbus::Connection> {
    if std::env::var_os("WAYLAND_DISPLAY").is_none() {
        return Err(Failure::new(
            "unsupported-platform",
            "Wayland graphical-session environment is required; X11 is unsupported",
        ));
    }
    let connection = zbus::Connection::session()
        .await
        .map_err(|e| Failure::new("prerequisite", e))?;
    ashpd::register_host_app_with_connection(connection.clone(), APP_ID.parse()?).await?;
    Ok(connection)
}

pub fn missing(error: &ashpd::Error) -> bool {
    matches!(
        error,
        ashpd::Error::PortalNotFound(_) | ashpd::Error::RequiresVersion(_, _)
    ) || matches!(
        error,
        ashpd::Error::Zbus(zbus::Error::MethodError(name, _, _))
            if matches!(
                name.as_str(),
                "org.freedesktop.DBus.Error.UnknownMethod"
                    | "org.freedesktop.DBus.Error.UnknownInterface"
            )
    )
}

pub struct Discovery {
    pub sources: Vec<Source>,
    pub capture: bool,
    pub remote: bool,
    pub clipboard: bool,
    pub open: bool,
    pub direct: direct::Capabilities,
}

pub async fn discover() -> Result<Discovery> {
    let bus = connection().await?;
    let cast = Screencast::with_connection(bus.clone()).await;
    let sources = match &cast {
        Ok(cast) => {
            let mask = cast.available_source_types().await?;
            let mut sources = Vec::new();
            if mask.contains(SourceType::Monitor) {
                sources.push(Source::Monitor);
            }
            if mask.contains(SourceType::Window) {
                sources.push(Source::Window);
            }
            sources
        }
        Err(e) if missing(e) => Vec::new(),
        Err(e) => return Err(Failure::new("backend-error", e)),
    };
    let remote = match RemoteDesktop::with_connection(bus.clone()).await {
        Ok(_) => true,
        Err(e) if missing(&e) => false,
        Err(e) => return Err(e.into()),
    };
    let clipboard = match Clipboard::with_connection(bus.clone()).await {
        Ok(_) => true,
        Err(e) if missing(&e) => false,
        Err(e) => return Err(e.into()),
    };
    let open = crate::workspace::available(&bus).await;
    Ok(Discovery {
        capture: !sources.is_empty(),
        sources,
        remote,
        clipboard,
        open,
        direct: direct::discover()?,
    })
}

pub enum Handle {
    Cast(Arc<Session<Screencast>>, Arc<AtomicBool>),
    Remote(Arc<Session<RemoteDesktop>>, Arc<AtomicBool>),
}

impl Handle {
    pub async fn close(&self) {
        match self {
            Self::Cast(s, closed) => {
                if !closed.swap(true, Ordering::AcqRel) {
                    let _ = s.close().await;
                }
            }
            Self::Remote(s, closed) => {
                if !closed.swap(true, Ordering::AcqRel) {
                    let _ = s.close().await;
                }
            }
        }
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        match self {
            Self::Cast(s, closed) => {
                if !closed.swap(true, Ordering::AcqRel) {
                    let s = s.clone();
                    tokio::spawn(async move {
                        let _ = s.close().await;
                    });
                }
            }
            Self::Remote(s, closed) => {
                if !closed.swap(true, Ordering::AcqRel) {
                    let s = s.clone();
                    tokio::spawn(async move {
                        let _ = s.close().await;
                    });
                }
            }
        }
    }
}

pub enum InputBackend {
    None,
    Eis(Eis),
    Notify {
        proxy: Arc<RemoteDesktop>,
        keys: std::collections::HashSet<u32>,
        buttons: std::collections::HashSet<u32>,
    },
    Direct(direct::Direct),
}

impl InputBackend {
    pub fn name(&self) -> &'static str {
        match self {
            Self::None => "portal-screencast",
            Self::Eis(_) => "portal-eis",
            Self::Notify { .. } => "portal-notify",
            Self::Direct(_) => "compositor-socket",
        }
    }
}

pub struct Portal {
    pub handle: Handle,
    pub stream: Stream,
    pub capture: capture::Capture,
    pub backend: InputBackend,
    pub clipboard: Option<Arc<Clipboard>>,
    pub clipboard_denied: bool,
    pub data_control: bool,
    pub live: Arc<AtomicBool>,
    monitors: Vec<tokio::task::JoinHandle<()>>,
}

impl Portal {
    pub async fn create(
        source: Source,
        control: bool,
        output_name: Option<&str>,
        state: &Path,
    ) -> Result<Self> {
        let token_path = token_path(state, &source, control)?;
        let token = match std::fs::read_to_string(&token_path) {
            Ok(token) => {
                std::fs::remove_file(&token_path).map_err(|e| Failure::new("prerequisite", e))?;
                Some(token)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(Failure::new("prerequisite", e)),
        };
        match Self::attempt(
            source.clone(),
            control,
            output_name,
            token.as_deref(),
            &token_path,
        )
        .await
        {
            Err(e) if e.code == "invalid-restore-token" && token.is_some() => {
                Self::attempt(source, control, output_name, None, &token_path).await
            }
            result => result,
        }
    }
    async fn attempt(
        source: Source,
        control: bool,
        output_name: Option<&str>,
        token: Option<&str>,
        token_path: &Path,
    ) -> Result<Self> {
        let bus = connection().await?;
        let cast = Screencast::with_connection(bus.clone()).await?;
        let source_type = match source {
            Source::Monitor => SourceType::Monitor,
            Source::Window => SourceType::Window,
        };
        if !cast.available_source_types().await?.contains(source_type) {
            return Err(Failure::new(
                "missing-protocol",
                "Requested portal source type is unavailable",
            ));
        }
        let cursor = if cast
            .available_cursor_modes()
            .await?
            .contains(CursorMode::Embedded)
        {
            CursorMode::Embedded
        } else {
            CursorMode::Hidden
        };
        let source_options = || {
            SelectSourcesOptions::default()
                .set_sources(enumflags2::BitFlags::from(source_type))
                .set_multiple(false)
                .set_cursor_mode(cursor)
        };
        let remote = if control {
            match RemoteDesktop::with_connection(bus.clone()).await {
                Ok(proxy) => Some(Arc::new(proxy)),
                Err(e) if missing(&e) => None,
                Err(e) => return Err(e.into()),
            }
        } else {
            None
        };
        let mut clipboard = None;
        let mut clipboard_denied = false;
        let (handle, streams, restore, fd, backend) = if let Some(remote) = remote {
            let session = Arc::new(remote.create_session(Default::default()).await?);
            let handle = Handle::Remote(session.clone(), Arc::new(AtomicBool::new(false)));
            let devices = DeviceType::Keyboard | DeviceType::Pointer;
            if !remote.available_device_types().await?.contains(devices) {
                return Err(Failure::new(
                    "missing-protocol",
                    "Portal lacks requested keyboard/pointer device types",
                ));
            }
            remote
                .select_devices(
                    &session,
                    SelectDevicesOptions::default()
                        .set_devices(devices)
                        .set_persist_mode(PersistMode::ExplicitlyRevoked)
                        .set_restore_token(token),
                )
                .await
                .map_err(|e| restore_error(e, token))?
                .response()?;
            cast.select_sources(&session, source_options())
                .await?
                .response()?;
            match Clipboard::with_connection(bus.clone()).await {
                Ok(proxy) => {
                    proxy.request(&session, Default::default()).await?;
                    clipboard = Some(Arc::new(proxy));
                }
                Err(e) if missing(&e) => {}
                Err(e) => return Err(e.into()),
            }
            let response = remote
                .start(&session, None, Default::default())
                .await
                .map_err(|e| restore_error(e, token))?
                .response()?;
            if !response.devices().contains(devices) {
                return Err(Failure::new(
                    "denied",
                    "Portal did not grant requested keyboard and pointer devices",
                ));
            }
            if clipboard.is_some() && !response.is_clipboard_enabled() {
                clipboard_denied = true;
                clipboard = None;
            }
            let fd = cast
                .open_pipe_wire_remote(&session, Default::default())
                .await?;
            let backend = match remote.connect_to_eis(&session, Default::default()).await {
                Ok(fd) => InputBackend::Eis(Eis::connect(fd).await?),
                Err(e) if missing(&e) => InputBackend::Notify {
                    proxy: remote,
                    keys: Default::default(),
                    buttons: Default::default(),
                },
                Err(e) => return Err(e.into()),
            };
            (
                handle,
                response.streams().to_vec(),
                response.restore_token().map(str::to_owned),
                fd,
                backend,
            )
        } else {
            if control && source == Source::Window {
                return Err(Failure::new(
                    "mapping-unavailable",
                    "Direct input cannot bind a window capture",
                ));
            }
            let output = if control {
                Some(output_name.filter(|s| !s.is_empty()).ok_or_else(|| {
                    Failure::new(
                        "mapping-unavailable",
                        "Direct input requires an explicit outputName selected by the user",
                    )
                })?)
            } else {
                None
            };
            let session = Arc::new(cast.create_session(Default::default()).await?);
            let handle = Handle::Cast(session.clone(), Arc::new(AtomicBool::new(false)));
            cast.select_sources(
                &session,
                source_options()
                    .set_persist_mode(PersistMode::ExplicitlyRevoked)
                    .set_restore_token(token),
            )
            .await
            .map_err(|e| restore_error(e, token))?
            .response()?;
            let response = cast
                .start(&session, None, Default::default())
                .await
                .map_err(|e| restore_error(e, token))?
                .response()?;
            let fd = cast
                .open_pipe_wire_remote(&session, Default::default())
                .await?;
            let backend = if let Some(output) = output {
                InputBackend::Direct(direct::Direct::connect(output).await?)
            } else {
                InputBackend::None
            };
            (
                handle,
                response.streams().to_vec(),
                response.restore_token().map(str::to_owned),
                fd,
                backend,
            )
        };
        if streams.len() != 1 {
            return Err(Failure::new(
                "mapping-unavailable",
                "Portal returned an ambiguous stream selection",
            ));
        }
        let stream = streams
            .into_iter()
            .next()
            .ok_or_else(|| Failure::new("mapping-unavailable", "Portal returned no stream"))?;
        if stream.source_type().is_some_and(|kind| kind != source_type) {
            return Err(Failure::new(
                "mapping-unavailable",
                "Portal returned a different source kind",
            ));
        }
        let capture = capture::Capture::new(fd, stream.pipe_wire_node_id())?;
        // Restored streams may not expose EI regions until PipeWire starts consuming
        if let InputBackend::Eis(eis) = &backend {
            eis.wait_ready().await?;
        }
        if let Some(token) = restore {
            write_token(token_path, &token)?;
        }
        let live = Arc::new(AtomicBool::new(true));
        let mut monitors = Vec::new();
        match &handle {
            Handle::Remote(session, closed) => {
                let session = session.clone();
                let live = live.clone();
                let ended = closed.clone();
                monitors.push(tokio::spawn(async move {
                    if let Ok(mut closed) = session.receive_closed().await {
                        let _ = closed.next().await;
                    }
                    ended.store(true, Ordering::Release);
                    live.store(false, Ordering::Release);
                }));
            }
            Handle::Cast(session, closed) => {
                let session = session.clone();
                let live = live.clone();
                let ended = closed.clone();
                monitors.push(tokio::spawn(async move {
                    if let Ok(mut closed) = session.receive_closed().await {
                        let _ = closed.next().await;
                    }
                    ended.store(true, Ordering::Release);
                    live.store(false, Ordering::Release);
                }));
            }
        }
        let owner_live = live.clone();
        let owner_closed = match &handle {
            Handle::Cast(_, closed) | Handle::Remote(_, closed) => closed.clone(),
        };
        monitors.push(tokio::spawn(async move {
            if let Ok(proxy) = zbus::Proxy::new(
                &bus,
                "org.freedesktop.portal.Desktop",
                "/org/freedesktop/portal/desktop",
                "org.freedesktop.portal.Desktop",
            )
            .await
                && let Ok(mut changes) = proxy.receive_owner_changed().await
            {
                let _ = changes.next().await;
            }
            owner_closed.store(true, Ordering::Release);
            owner_live.store(false, Ordering::Release);
        }));
        Ok(Self {
            handle,
            stream,
            capture,
            backend,
            clipboard,
            clipboard_denied,
            data_control: direct::discover()?.clipboard,
            live,
            monitors,
        })
    }
}

impl Drop for Portal {
    fn drop(&mut self) {
        for task in &self.monitors {
            task.abort();
        }
    }
}

fn restore_error(error: ashpd::Error, token: Option<&str>) -> Failure {
    if token.is_some()
        && matches!(
            &error,
            ashpd::Error::Portal(ashpd::PortalError::InvalidArgument(_))
        )
    {
        Failure::new("invalid-restore-token", "Portal rejected restore token")
    } else {
        error.into()
    }
}

fn token_path(state: &Path, source: &Source, control: bool) -> Result<PathBuf> {
    let directory = state.join("tokens");
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&directory)
        .map_err(|e| Failure::new("prerequisite", e))?;
    use std::os::unix::fs::MetadataExt;
    let metadata =
        std::fs::symlink_metadata(&directory).map_err(|e| Failure::new("prerequisite", e))?;
    if !metadata.is_dir()
        || metadata.uid() != rustix::process::geteuid().as_raw()
        || metadata.mode() & 0o077 != 0
    {
        return Err(Failure::new(
            "prerequisite",
            "Restore token directory must be private and owned by this UID",
        ));
    }
    Ok(directory.join(format!(
        "{}-{}",
        if control { "control" } else { "capture" },
        if *source == Source::Monitor {
            "monitor"
        } else {
            "window"
        }
    )))
}

fn write_token(path: &Path, token: &str) -> Result<()> {
    use std::io::Write;
    // Persist beside the target so replacement stays atomic on one filesystem
    let mut file = tempfile::NamedTempFile::new_in(path.parent().unwrap_or(Path::new(".")))
        .map_err(|e| Failure::new("prerequisite", e))?;
    file.write_all(token.as_bytes())
        .and_then(|()| file.as_file().sync_all())
        .map_err(|e| Failure::new("prerequisite", e))?;
    file.persist(path)
        .map(|_| ())
        .map_err(|e| Failure::new("prerequisite", e))
}

pub async fn open(uri: &str) -> Result<crate::workspace::Lease> {
    if uri.len() > 65536 {
        return Err(Failure::new("invalid-request", "URI exceeds limit"));
    }
    let parsed: ashpd::Uri = uri
        .parse()
        .map_err(|e| Failure::new("invalid-request", e))?;
    let bus = connection().await?;
    crate::workspace::Lease::open(bus, parsed.as_str()).await
}
