mod capture;
mod clipboard;
mod direct;
mod eis;
mod portal;
mod protocol;
mod session;
mod transport;
mod workspace;

use base64::Engine;
use clap::Parser;
use protocol::*;
use rmcp::{
    RoleServer, ServerHandler, ServiceExt,
    handler::server::tool::{IntoCallToolResult, ToolCallContext, ToolRouter},
    model::*,
    service::RequestContext,
};
use serde_json::{Value, json};
use std::{
    os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{
        Arc, LazyLock,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
};
use tokio::{net::UnixListener, sync::Mutex};
use tokio_util::sync::CancellationToken;

struct Shared {
    state: PathBuf,
    installation_id: String,
    lease: AtomicU64,
    sessions: AtomicUsize,
    profiles: Mutex<()>,
}
#[derive(Clone)]
struct Channel {
    id: u64,
    shared: Arc<Shared>,
    session: Arc<Mutex<Option<session::Session>>>,
    negotiated: Arc<AtomicBool>,
    closed: CancellationToken,
    workspaces: Arc<Mutex<Vec<workspace::Lease>>>,
}

impl Channel {
    async fn release(&self, session: &mut Option<session::Session>) {
        if let Some(mut previous) = session.take() {
            previous.close().await;
            self.shared.sessions.fetch_sub(1, Ordering::AcqRel);
        }
        let _ = self
            .shared
            .lease
            .compare_exchange(self.id, 0, Ordering::AcqRel, Ordering::Acquire);
    }
}

struct ToolSession {
    channel: Channel,
    session: Mutex<Option<session::Session>>,
}
impl IntoCallToolResult for Failure {
    fn into_call_tool_result(self) -> Result<CallToolResponse, rmcp::ErrorData> {
        Ok(CallToolResult::structured_error(self.value()).into())
    }
}

// Keep metadata, argument decoding and dispatch on the same declaration
macro_rules! desktop_tools {
    ($($name:ident(&$this:ident, $request:tt: $ty:ty)
        => $wire:literal, $description:literal $body:block)*) => {
        static TOOL_ORDER: &[&str] = &[$($wire),*];
        #[rmcp::tool_router]
        impl ToolSession {
            $(#[rmcp::tool(name = $wire, description = $description,
                input_schema = schemars::schema_for!($ty).ensure_object().clone())]
            async fn $name(&$this, arguments: JsonObject) -> Result<CallToolResult> {
                let $request: $ty = decode(Value::Object(arguments))?;
                Ok($body)
            })*
        }
    };
}
static TOOLS: LazyLock<ToolRouter<ToolSession>> = LazyLock::new(ToolSession::tool_router);

desktop_tools! {
    handshake(&self, _: Empty) => "helper.handshake",
        "Negotiate helper protocol and immutable installation identity" {
        self.channel.negotiated.store(true, Ordering::Release);
        CallToolResult::structured(json!({
            "protocolMajor": 1,
            "version": env!("CARGO_PKG_VERSION"),
            "installationId": self.channel.shared.installation_id,
            "platform": "linux",
            "capabilities": ["desktop", "bounded-png", "frame-bound-input", "text-receipts"],
        }))
    }
    health(&self, _: Empty) => "helper.health",
        "Inspect active lease and session count without effects" {
        CallToolResult::structured(json!({
            "controlLeaseActive": self.channel.shared.lease.load(Ordering::Acquire) != 0,
            "sessions": self.channel.shared.sessions.load(Ordering::Acquire),
        }))
    }
    inspect(&self, _: Empty) => "desktop.inspect",
        "Discover available, requestable and granted operations without consent" {
                let session = self.session.lock().await;
                let discovery = portal::discover().await?;
                let controlled = session.as_ref().is_some_and(session::Session::control);
                let remote_backend = if discovery.remote {
                    "portal-remote-desktop"
                } else {
                    "compositor-socket"
                };
                let operation = |name: &str,
                                 available: bool,
                                 requestable: bool,
                                 granted: bool,
                                 backend: &str,
                                 reason: &str| {
                    json!({
                        "operation": name,
                        "available": available,
                        "requestable": requestable,
                        "granted": granted,
                        "backend": if available { Some(backend) } else { None },
                        "reason": if available { None } else { Some(reason) },
                    })
                };
                CallToolResult::structured(json!({
                    "status": "ok",
                    "operations": [
                        operation(
                            "capture",
                            discovery.capture,
                            discovery.capture,
                            session.is_some(),
                            "portal-screencast",
                            "ScreenCast portal/source unavailable",
                        ),
                        operation(
                            "keyboard",
                            discovery.remote || discovery.direct.keyboard,
                            discovery.remote,
                            controlled,
                            remote_backend,
                            "RemoteDesktop and virtual keyboard unavailable",
                        ),
                        operation(
                            "pointer",
                            discovery.remote || discovery.direct.pointer,
                            discovery.remote,
                            controlled,
                            remote_backend,
                            "RemoteDesktop and output-bound virtual pointer unavailable",
                        ),
                        operation(
                            "clipboard",
                            discovery.clipboard || discovery.direct.clipboard,
                            discovery.clipboard,
                            session.as_ref().is_some_and(|s| {
                                s.portal.clipboard.is_some()
                                    || (!s.portal.clipboard_denied && s.portal.data_control)
                            }),
                            if discovery.clipboard {
                                "portal-clipboard"
                            } else {
                                "data-control"
                            },
                            "Clipboard interfaces unavailable",
                        ),
                        operation(
                            "open",
                            discovery.open,
                            false,
                            discovery.open,
                            "gnome-mutter-workspace",
                            "GNOME 50 workspace adapter or static all-monitor workspaces unavailable",
                        ),
                    ],
                    "sources": discovery.sources,
                    "sessionId": session.as_ref().map(|s| &s.id),
                }))
            }
    open(&self, request: Open) => "desktop.open",
        "Open a native URI handler in an owned GNOME workspace without activating it; returns workspaceId for explicit release and releases on connection close" {
                let lease = portal::open(&request.uri).await?;
                let id = lease.id.clone();
                self.channel.workspaces.lock().await.push(lease);
                CallToolResult::structured(json!({"status": "ok", "workspaceId": id}))
            }
    workspace_release(&self, request: WorkspaceRelease) => "desktop.workspace.release",
        "Stop an owned GUI launch and remove its workspace only when empty and inactive" {
                let mut leases = self.channel.workspaces.lock().await;
                let index = leases.iter().position(|lease| lease.id == request.workspace_id)
                    .ok_or_else(|| Failure::new("invalid-request", "Unknown owned workspace lease"))?;
                leases.swap_remove(index).release().await?;
                CallToolResult::structured(json!({"status": "ok"}))
            }
    authorize(&self, request: Authorize) => "desktop.authorize",
        "Request combined control/capture consent; direct WM input is socket-authorized" {
                let mut session = self.session.lock().await;
                if request
                    .output_name
                    .as_ref()
                    .is_some_and(|s| s.is_empty() || s.len() > 1024)
                {
                    return Err(Failure::new("invalid-request", "Invalid outputName"));
                }
                let gate = maintenance_gate(&self.channel.shared.state)?;
                let current = self.channel.shared.lease.load(Ordering::Acquire);
                if current != self.channel.id
                    && self.channel
                        .shared
                        .lease
                        .compare_exchange(0, self.channel.id, Ordering::AcqRel, Ordering::Acquire)
                        .is_err()
                {
                    return Err(Failure::new(
                        "busy",
                        "Another channel owns the desktop control lease",
                    ));
                }
                drop(gate);
                if let Some(mut previous) = session.take() {
                    previous.close().await;
                    self.channel.shared.sessions.fetch_sub(1, Ordering::AcqRel);
                }
                let _profile = self.channel.shared.profiles.lock().await;
                let portal = match portal::Portal::create(
                    request.source.clone(),
                    true,
                    request.output_name.as_deref(),
                    &self.channel.shared.state,
                )
                .await
                {
                    Ok(portal) => portal,
                    Err(error) => {
                        let _ = self.channel.shared.lease.compare_exchange(
                            self.channel.id,
                            0,
                            Ordering::AcqRel,
                            Ordering::Acquire,
                        );
                        return Err(error);
                    }
                };
                let next = session::Session::new(request.source.clone(), portal);
                let result = json!({
                    "status": "ok",
                    "sessionId": next.id,
                    "source": request.source,
                    "backend": next.portal.backend.name(),
                });
                *session = Some(next);
                self.channel.shared.sessions.fetch_add(1, Ordering::AcqRel);
                CallToolResult::structured(result)
            }
    capture(&self, request: Capture) => "desktop.capture",
        "Capture the selected source, returning one PNG and frame metadata" {
                let mut session = self.session.lock().await;
                if let Some(id) = &request.session_id {
                    validate_id(id)?;
                }
                if let Some(id) = &request.session_id
                    && session.as_ref().is_none_or(|s| &s.id != id)
                {
                    return Err(Failure::new(
                        "closed-session",
                        "Capture session is not owned by this channel",
                    ));
                }
                if session.is_none() {
                    let source = request.source.unwrap_or_default();
                    let _profile = self.channel.shared.profiles.lock().await;
                    let portal =
                        portal::Portal::create(source.clone(), false, None, &self.channel.shared.state)
                            .await?;
                    *session = Some(session::Session::new(source, portal));
                    self.channel.shared.sessions.fetch_add(1, Ordering::AcqRel);
                } else if request
                    .source
                    .as_ref()
                    .is_some_and(|source| session.as_ref().is_some_and(|s| &s.source != source))
                {
                    return Err(Failure::new(
                        "invalid-request",
                        "Requested source differs from the owned session",
                    ));
                }
                let active = session
                    .as_mut()
                    .ok_or_else(|| Failure::new("closed-session", "No capture session"))?;
                let (frame, png) = active.capture().await?;
                let mut result = CallToolResult::structured(json!({
                    "status": "ok",
                    "frame": frame,
                }));
                result.content.push(ContentBlock::image(
                    base64::engine::general_purpose::STANDARD.encode(png),
                    "image/png",
                ));
                result
            }
    input(&self, request: Input) => "desktop.input",
        "Submit serialized frame-bound input; clipboard paste may remain in clipboard history" {
                let mut session = self.session.lock().await;
                validate_id(&request.session_id)?;
                if let Some(frame) = &request.frame {
                    validate_id(&frame.stream_id)?;
                    validate_id(&frame.frame_id)?;
                }
                let active = session.as_mut().ok_or_else(|| {
                    Failure::new(
                        "authorization-required",
                        "Explicit desktop.authorize is required",
                    )
                })?;
                let receipt = active.input(request).await?;
                let mut result = json!({"status": "ok"});
                if let Some(receipt) = receipt {
                    result["receipt"] = json!(receipt);
                }
                CallToolResult::structured(result)
            }
    release_session(&self, request: Release) => "desktop.release",
        "Release owned input and close this channel's portal session" {
                let mut session = self.session.lock().await;
                if let Some(id) = &request.session_id {
                    validate_id(id)?;
                }
                if request
                    .session_id
                    .as_ref()
                    .is_some_and(|id| session.as_ref().is_none_or(|s| &s.id != id))
                {
                    return Err(Failure::new(
                        "closed-session",
                        "Release session is not owned by this channel",
                    ));
                }
                self.channel.release(&mut session).await;
                CallToolResult::structured(json!({"status": "ok"}))
            }
}

impl ServerHandler for Channel {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build()).with_server_info(
            Implementation::new("omp-helper-desktop", env!("CARGO_PKG_VERSION")),
        )
    }
    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> std::result::Result<ListToolsResult, rmcp::ErrorData> {
        Ok(ListToolsResult {
            tools: TOOL_ORDER
                .iter()
                .map(|name| TOOLS.get(name).expect("Generated tool route").clone())
                .collect(),
            ..Default::default()
        })
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> std::result::Result<CallToolResponse, rmcp::ErrorData> {
        let text = request.name == "desktop.input"
            && request
                .arguments
                .as_ref()
                .and_then(|args| args.get("action"))
                .and_then(|action| action.get("method"))
                .and_then(Value::as_str)
                == Some("type_text");
        let mut tools = ToolSession {
            channel: self.clone(),
            session: Mutex::new(None),
        };
        // Health remains responsive while another channel awaits a consent dialog
        if request.name == "helper.health" {
            return TOOLS
                .call(ToolCallContext::new(&tools, request, context))
                .await;
        }
        let mut session = self.session.lock().await;
        if text && let Some(session) = session.as_mut() {
            session.reset_receipt();
        }
        // Restore the owned session even when cancellation drops the router future
        *tools.session.get_mut() = session.take();
        let cancelled = context.ct.clone();
        let result = tokio::select! {
            biased;
            _ = self.closed.cancelled() => Failure::new(
                "disconnected", "Desktop channel closed",
            ).into_call_tool_result(),
            _ = cancelled.cancelled() => Failure::new(
                "cancelled", "Desktop operation cancelled; input is released",
            ).into_call_tool_result(),
            result = async {
                if request.name != "helper.handshake" && !self.negotiated.load(Ordering::Acquire) {
                    return Failure::new(
                        "prerequisite", "Negotiate helper.handshake before desktop operations",
                    ).into_call_tool_result();
                }
                TOOLS.call(ToolCallContext::new(&tools, request, context)).await
            } => result,
        };
        *session = tools.session.into_inner();
        let mut result = result.unwrap_or_else(|_| {
            CallToolResult::structured_error(
                Failure::new("invalid-request", "Unknown desktop tool").value(),
            )
            .into()
        });
        if let CallToolResponse::Complete(result) = &mut result
            && result.is_error == Some(true)
            && let Some(error) = result.structured_content.as_mut()
        {
            let receipt_added = text && error.get("receipt").is_none();
            if receipt_added {
                error["receipt"] = json!(
                    session
                        .as_ref()
                        .and_then(|s| s.receipt())
                        .unwrap_or_default()
                );
            }
            if matches!(
                error.get("code").and_then(Value::as_str),
                Some("cancelled" | "disconnected" | "closed-session")
            ) {
                self.release(&mut session).await;
            }
            if receipt_added && let Some(error) = result.structured_content.take() {
                *result = CallToolResult::structured_error(error);
            }
        }
        Ok(result)
    }
}

fn maintenance_gate(state: &Path) -> Result<scopeguard::ScopeGuard<PathBuf, impl FnOnce(PathBuf)>> {
    use std::io::Write;
    let path = state.join("maintenance.lock");
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&path)
        .map_err(|e| {
            Failure::new(
                if e.kind() == std::io::ErrorKind::AlreadyExists {
                    "busy"
                } else {
                    "prerequisite"
                },
                "Helper maintenance gate unavailable; do not steal a surviving lock",
            )
        })?;
    let gate = scopeguard::guard(path, |path| {
        let _ = std::fs::remove_file(path.join("owner.json"));
        let _ = std::fs::remove_dir(path);
    });
    let mut owner = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(gate.join("owner.json"))
        .map_err(|e| Failure::new("prerequisite", e))?;
    owner
        .write_all(json!({"pid": std::process::id()}).to_string().as_bytes())
        .map_err(|e| Failure::new("prerequisite", e))?;
    Ok(gate)
}

fn private_directory(path: &Path) -> Result<()> {
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
        .map_err(|e| Failure::new("prerequisite", e))?;
    let metadata = std::fs::symlink_metadata(path).map_err(|e| Failure::new("prerequisite", e))?;
    if !metadata.is_dir()
        || metadata.uid() != rustix::process::geteuid().as_raw()
        || metadata.mode() & 0o077 != 0
    {
        return Err(Failure::new(
            "prerequisite",
            "Helper directory must be owned by this UID and mode 0700",
        ));
    }
    Ok(())
}

async fn daemon() -> Result<()> {
    let runtime = dirs::runtime_dir()
        .ok_or_else(|| Failure::new("prerequisite", "XDG_RUNTIME_DIR is missing"))?
        .join("omp-helper");
    let state = dirs::state_dir()
        .ok_or_else(|| Failure::new("prerequisite", "User state directory is missing"))?
        .join("omp-helper");
    private_directory(&runtime)?;
    private_directory(&state)?;
    let identity = state.join("installation.json");
    let metadata =
        std::fs::symlink_metadata(&identity).map_err(|e| Failure::new("prerequisite", e))?;
    if !metadata.is_file()
        || metadata.uid() != rustix::process::geteuid().as_raw()
        || metadata.mode() & 0o077 != 0
        || metadata.len() > 4096
    {
        return Err(Failure::new(
            "prerequisite",
            "Installation identity must be private, owned and bounded",
        ));
    }
    let identity: Value = serde_json::from_slice(
        &std::fs::read(identity).map_err(|e| Failure::new("prerequisite", e))?,
    )
    .map_err(|e| Failure::new("prerequisite", e))?;
    let installation_id = identity
        .get("installationId")
        .and_then(Value::as_str)
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        .ok_or_else(|| {
            Failure::new(
                "prerequisite",
                "Installer has not created a valid installation UUID",
            )
        })?
        .to_owned();
    let socket = runtime.join("desktop.sock");
    if let Ok(metadata) = std::fs::symlink_metadata(&socket) {
        if !metadata.file_type().is_socket()
            || metadata.uid() != rustix::process::geteuid().as_raw()
        {
            return Err(Failure::new(
                "prerequisite",
                "Refusing unrelated desktop socket path",
            ));
        }
        if tokio::net::UnixStream::connect(&socket).await.is_ok() {
            return Err(Failure::new(
                "busy",
                "Desktop daemon already listens on this socket",
            ));
        }
        std::fs::remove_file(&socket).map_err(|e| Failure::new("prerequisite", e))?;
    }
    let listener = UnixListener::bind(&socket).map_err(|e| Failure::new("prerequisite", e))?;
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| Failure::new("prerequisite", e))?;
    let shared = Arc::new(Shared {
        state,
        installation_id,
        lease: AtomicU64::new(0),
        sessions: AtomicUsize::new(0),
        profiles: Mutex::new(()),
    });
    let shutdown = CancellationToken::new();
    let stopping = shutdown.clone();
    tokio::spawn(async move {
        let mut term =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).ok();
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = async {
                if let Some(term) = &mut term {
                    term.recv().await;
                } else {
                    std::future::pending::<()>().await;
                }
            } => {},
        }
        stopping.cancel();
    });
    let mut tasks = tokio::task::JoinSet::new();
    let mut next = 1_u64;
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => break,
            connection = listener.accept() => {
                let (stream, _) = connection.map_err(|e| Failure::new("disconnected", e))?;
                if stream
                    .peer_cred()
                    .map_err(|e| Failure::new("disconnected", e))?
                    .uid()
                    != rustix::process::geteuid().as_raw()
                {
                    continue;
                }
                let channel = Channel {
                    id: next,
                    shared: shared.clone(),
                    session: Arc::new(Mutex::new(None)),
                    negotiated: Arc::new(AtomicBool::new(false)),
                    workspaces: Arc::new(Mutex::new(Vec::new())),
                    closed: shutdown.child_token(),
                };
                next = next.wrapping_add(1).max(1);
                tasks.spawn(async move {
                    let watcher = channel.clone();
                    let maintenance = tokio::spawn(async move {
                        let mut interval =
                            tokio::time::interval(std::time::Duration::from_millis(100));
                        let mut capture_stopped: Option<CancellationToken> = None;
                        loop {
                            tokio::select! {
                                _ = watcher.closed.cancelled() => break,
                                _ = interval.tick() => {},
                                _ = async {
                                    if let Some(stopped) = &capture_stopped {
                                        stopped.cancelled().await;
                                    } else {
                                        std::future::pending::<()>().await;
                                    }
                                } => {
                                    capture_stopped = None;
                                },
                            }
                            if let Ok(mut state) = watcher.session.try_lock() {
                                if let Some(session) = state.as_mut() {
                                    if session.invalidated() {
                                        session.invalidate().await;
                                    }
                                    capture_stopped =
                                        if session.portal.capture.stopped.is_cancelled() {
                                            None
                                        } else {
                                            Some(session.portal.capture.stopped.clone())
                                        };
                                    if !session.portal.live.load(Ordering::Acquire) {
                                        watcher.release(&mut state).await;
                                        capture_stopped = None;
                                    }
                                } else {
                                    capture_stopped = None;
                                }
                            }
                        }
                    });
                    let (read, write) = stream.into_split();
                    let transport = (
                        transport::BoundedIo::new(read, MAX_REQUEST, channel.closed.clone()),
                        transport::BoundedIo::new(write, MAX_RESPONSE, channel.closed.clone()),
                    );
                    if let Ok(service) = channel.clone().serve(transport).await {
                        let cancellation = service.cancellation_token();
                        tokio::select! {
                            _ = service.waiting() => {},
                            _ = channel.closed.cancelled() => {
                                cancellation.cancel();
                            },
                        }
                    }
                    channel.closed.cancel();
                    maintenance.abort();
                    channel.release(&mut *channel.session.lock().await).await;
                    for lease in channel.workspaces.lock().await.drain(..) {
                        let _ = lease.release().await;
                    }
                });
            },
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {},
        }
    }
    while tasks.join_next().await.is_some() {}
    let _ = std::fs::remove_file(socket);
    Ok(())
}
#[derive(Parser)]
enum Cli {
    /// Serve desktop tools over the private Unix socket
    Daemon,
    /// Own a data-control clipboard selection supplied on stdin
    ClipboardWorker,
    /// Run a command in an isolated desktop workspace
    WorkspaceRun {
        #[arg(last = true, required = true, num_args = 1.., value_name = "EXECUTABLE [ARGUMENTS]")]
        arguments: Vec<String>,
    },
    /// Attach to the workspace scope and exec the isolated command
    WorkspaceChild {
        id: String,
        #[arg(last = true, required = true, num_args = 1.., value_name = "EXECUTABLE [ARGUMENTS]")]
        arguments: Vec<String>,
    },
    /// Restore the trusted socket only after the private bus daemon starts
    #[command(hide = true)]
    WorkspaceApp {
        #[arg(last = true, required = true, num_args = 1.., value_name = "EXECUTABLE [ARGUMENTS]")]
        arguments: Vec<String>,
    },
}

#[tokio::main]
async fn main() {
    let result: Result<i32> = match Cli::parse() {
        Cli::Daemon => daemon().await.map(|()| 0),
        Cli::ClipboardWorker => clipboard::worker().map(|()| 0),
        Cli::WorkspaceRun { arguments } => workspace::run(&arguments).await,
        Cli::WorkspaceChild { id, arguments } => {
            workspace::child(&id, &arguments).await.map(|()| 0)
        }
        Cli::WorkspaceApp { arguments } => workspace::app(&arguments).map(|()| 0),
    };
    std::process::exit(match result {
        Ok(status) => status,
        Err(error) => {
            eprintln!("{}: {}", error.code, error.message);
            1
        }
    });
}
