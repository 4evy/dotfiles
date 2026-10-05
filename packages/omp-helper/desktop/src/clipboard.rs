use crate::{
    portal::{Handle, Portal},
    protocol::{Failure, MAX_REQUEST, Result},
};
use ashpd::desktop::{clipboard::SetSelectionOptions, remote_desktop::RemoteDesktop};
use futures_util::StreamExt;
use std::{
    io::{Read, Write},
    process::Stdio,
    sync::Arc,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub enum Owner {
    Portal(tokio::task::JoinHandle<()>),
    DataControl(tokio::process::Child),
}

impl Drop for Owner {
    fn drop(&mut self) {
        match self {
            Self::Portal(task) => task.abort(),
            Self::DataControl(child) => {
                let _ = child.start_kill();
            }
        }
    }
}

pub async fn publish(
    portal: &Portal,
    text: &str,
    effects: Arc<std::sync::Mutex<crate::protocol::Receipt>>,
) -> Result<(Owner, &'static str)> {
    if let (Some(clipboard), Handle::Remote(session, _)) = (&portal.clipboard, &portal.handle) {
        let clipboard = clipboard.clone();
        let session = session.clone();
        let expected =
            serde_json::to_value(session.as_ref()).map_err(|e| Failure::new("backend-error", e))?;
        let bytes = Arc::new(text.as_bytes().to_vec());
        let (ready, initialized) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let subscriptions = async {
                let transfers = clipboard
                    .receive_selection_transfer::<RemoteDesktop>()
                    .await?;
                let ownership = clipboard
                    .receive_selection_owner_changed::<RemoteDesktop>()
                    .await?;
                if let Ok(mut receipt) = effects.lock() {
                    receipt.mechanism = "portal-clipboard";
                    receipt.partial = true;
                }
                // Subscribe before publication, including clipboard-manager reads
                clipboard
                    .set_selection(
                        &session,
                        SetSelectionOptions::default().set_mime_types(&[
                            "text/plain;charset=utf-8",
                            "text/plain",
                            "UTF8_STRING",
                        ]),
                    )
                    .await?;
                if let Ok(mut receipt) = effects.lock() {
                    receipt.clipboard_changed = true;
                }
                Ok::<_, ashpd::Error>((transfers, ownership))
            }
            .await;
            let (transfers, ownership) = match subscriptions {
                Ok(streams) => {
                    let _ = ready.send(Ok(()));
                    streams
                }
                Err(error) => {
                    let _ = ready.send(Err(Failure::from(error)));
                    return;
                }
            };
            futures_util::pin_mut!(transfers, ownership);
            loop {
                tokio::select! {
                    request = transfers.next() => {
                        let Some((target, mime, serial)) = request else {
                            break;
                        };
                        if serde_json::to_value(&target).ok().as_ref() != Some(&expected) {
                            continue;
                        }
                        let supported = matches!(
                            mime.as_str(),
                            "text/plain;charset=utf-8" | "text/plain" | "UTF8_STRING"
                        );
                        let success = if supported {
                            match clipboard.selection_write(&session, serial).await {
                                Ok(fd) => tokio::time::timeout(
                                    std::time::Duration::from_secs(30),
                                    transfer(fd.into(), &bytes),
                                )
                                .await
                                .is_ok_and(|r| r.is_ok()),
                                Err(_) => false,
                            }
                        } else {
                            false
                        };
                        if clipboard
                            .selection_write_done(&session, serial, success)
                            .await
                            .is_err()
                        {
                            break;
                        }
                    },
                    changed = ownership.next() => {
                        let Some((target, changed)) = changed else {
                            break;
                        };
                        if serde_json::to_value(&target).ok().as_ref() == Some(&expected)
                            && changed.session_is_owner() == Some(false)
                        {
                            break;
                        }
                    },
                }
            }
        });
        let owner = Owner::Portal(task);
        initialized
            .await
            .map_err(|_| Failure::new("disconnected", "Clipboard transfer service ended"))??;
        return Ok((owner, "portal-clipboard"));
    }
    if portal.clipboard_denied {
        return Err(Failure::new(
            "denied",
            "Clipboard access was explicitly denied; data-control fallback is prohibited",
        ));
    }
    if !portal.data_control {
        return Err(Failure::new(
            "unsupported-text",
            "No EI text or granted portal/data-control clipboard is available",
        ));
    }
    if let Ok(mut receipt) = effects.lock() {
        receipt.mechanism = "data-control";
        receipt.partial = true;
    }
    let executable = std::env::current_exe().map_err(|e| Failure::new("prerequisite", e))?;
    let mut child = tokio::process::Command::new(executable)
        .arg("clipboard-worker")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| Failure::new("backend-error", e))?;
    let mut input = child
        .stdin
        .take()
        .ok_or_else(|| Failure::new("backend-error", "Clipboard worker stdin unavailable"))?;
    input
        .write_all(text.as_bytes())
        .await
        .map_err(|e| Failure::new("backend-error", e))?;
    drop(input);
    let mut output = child
        .stdout
        .take()
        .ok_or_else(|| Failure::new("backend-error", "Clipboard worker readiness unavailable"))?;
    let mut ready = [0_u8; 1];
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        output.read_exact(&mut ready),
    )
    .await
    .map_err(|_| Failure::new("backend-error", "Clipboard ownership timed out"))?
    .map_err(|e| Failure::new("backend-error", e))?;
    if ready[0] != 1 {
        return Err(Failure::new(
            "backend-error",
            "Clipboard worker could not publish",
        ));
    }
    if let Ok(mut receipt) = effects.lock() {
        receipt.clipboard_changed = true;
    }
    Ok((Owner::DataControl(child), "data-control"))
}

// Portal transfers can use any pollable Unix FD, not just pipes
async fn transfer(fd: std::os::fd::OwnedFd, bytes: &[u8]) -> std::io::Result<()> {
    let flags = rustix::fs::fcntl_getfl(&fd)?;
    rustix::fs::fcntl_setfl(&fd, flags | rustix::fs::OFlags::NONBLOCK)?;
    let descriptor = tokio::io::unix::AsyncFd::new(fd)?;
    let mut remaining = bytes;
    while !remaining.is_empty() {
        let written = descriptor
            .async_io(tokio::io::Interest::WRITABLE, |fd| {
                rustix::io::write(fd, remaining).map_err(Into::into)
            })
            .await?;
        if written == 0 {
            return Err(std::io::ErrorKind::WriteZero.into());
        }
        remaining = &remaining[written..];
    }
    Ok(())
}

pub fn worker() -> Result<()> {
    let mut bytes = Vec::new();
    std::io::stdin()
        .take((MAX_REQUEST + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| Failure::new("backend-error", e))?;
    if bytes.len() > MAX_REQUEST || bytes.contains(&0) {
        return Err(Failure::new("invalid-request", "Invalid clipboard payload"));
    }
    use wl_clipboard_rs::{copy, paste};
    let marker = format!("application/x-omp-helper-{}", uuid::Uuid::new_v4());
    let offered_marker = marker.clone();
    let worker = std::thread::spawn(move || {
        let mut options = copy::Options::new();
        options.foreground(true);
        let prepared = options
            .prepare_copy_multi(vec![
                copy::MimeSource {
                    source: copy::Source::Bytes(bytes.into_boxed_slice()),
                    mime_type: copy::MimeType::Text,
                },
                copy::MimeSource {
                    source: copy::Source::Bytes(Box::new([])),
                    mime_type: copy::MimeType::Specific(offered_marker),
                },
            ])
            .map_err(|e| Failure::new("backend-error", e))?;
        prepared
            .serve()
            .map_err(|e| Failure::new("backend-error", e))
    });
    // Observe our unique MIME offer, never read the user's prior clipboard contents
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(9);
    loop {
        if paste::get_mime_types(paste::ClipboardType::Regular, paste::Seat::default())
            .is_ok_and(|types| types.contains(&marker))
        {
            break;
        }
        if worker.is_finished() || std::time::Instant::now() >= deadline {
            return Err(Failure::new(
                "backend-error",
                "Data-control ownership was not established",
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    std::io::stdout()
        .write_all(&[1])
        .and_then(|()| std::io::stdout().flush())
        .map_err(|e| Failure::new("backend-error", e))?;
    worker
        .join()
        .map_err(|_| Failure::new("backend-error", "Clipboard serving worker failed"))?
}
