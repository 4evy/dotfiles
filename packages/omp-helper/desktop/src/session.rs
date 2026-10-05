use crate::{
    capture, clipboard, direct,
    portal::{Handle, InputBackend, Portal},
    protocol::*,
};
use ashpd::desktop::remote_desktop::{KeyState, NotifyPointerAxisOptions};
use std::{collections::HashSet, sync::atomic::Ordering, time::Duration};
use xkbcommon::xkb;

struct Latest {
    frame: Frame,
    geometry: capture::Geometry,
    capture_generation: u64,
    input_generation: u64,
}

pub struct Session {
    pub id: String,
    pub source: Source,
    pub portal: Portal,
    last_receipt: Option<std::sync::Arc<std::sync::Mutex<Receipt>>>,
    submitted: bool,
    latest: Option<Latest>,
    capture_input_generation: u64,
    drag: Option<String>,
    clipboard: Option<clipboard::Owner>,
}

impl Session {
    pub fn new(source: Source, portal: Portal) -> Self {
        let mut session = Self {
            id: uuid::Uuid::new_v4().to_string(),
            source,
            portal,
            latest: None,
            capture_input_generation: 0,
            drag: None,
            clipboard: None,
            last_receipt: None,
            submitted: false,
        };
        session.capture_input_generation = session.input_generation();
        session
    }
    pub fn receipt(&self) -> Option<Receipt> {
        self.last_receipt
            .as_ref()
            .and_then(|r| r.lock().ok().map(|r| r.clone()))
    }
    pub fn reset_receipt(&mut self) {
        self.last_receipt = Some(std::sync::Arc::new(std::sync::Mutex::new(
            Receipt::default(),
        )));
    }
    fn set_receipt(&self, receipt: &Receipt) {
        if let Some(shared) = &self.last_receipt
            && let Ok(mut value) = shared.lock()
        {
            *value = receipt.clone();
        }
    }
    pub fn control(&self) -> bool {
        !matches!(self.portal.backend, InputBackend::None)
    }
    fn input_generation(&self) -> u64 {
        match &self.portal.backend {
            InputBackend::Eis(e) => e.generation.load(Ordering::Acquire),
            InputBackend::Direct(d) => d.generation.load(Ordering::Acquire),
            _ => 0,
        }
    }
    fn ensure_live(&self) -> Result<()> {
        if !self.portal.live.load(Ordering::Acquire) {
            return Err(Failure::new(
                "closed-session",
                "Portal session was closed or its owner changed",
            ));
        }
        self.portal.capture.ensure_live()
    }
    pub fn invalidated(&self) -> bool {
        !self.portal.live.load(Ordering::Acquire)
            || self.latest.as_ref().is_some_and(|f| {
                self.portal.capture.stopped.is_cancelled()
                    || f.capture_generation
                        != self.portal.capture.generation.load(Ordering::Acquire)
                    || f.input_generation != self.input_generation()
            })
    }
    pub async fn invalidate(&mut self) {
        self.release_input().await;
        self.latest = None;
    }
    pub async fn close(&mut self) {
        self.release_input().await;
        self.clipboard = None;
        self.portal.handle.close().await;
    }
    pub async fn capture(&mut self) -> Result<(Frame, Vec<u8>)> {
        if let Err(error) = self.ensure_live() {
            self.invalidate().await;
            return Err(error);
        }
        let input_generation = self.input_generation();
        if self.capture_input_generation != input_generation {
            self.invalidate().await;
            self.portal.capture.discard_sample()?;
            self.capture_input_generation = input_generation;
        }
        let image = match self.portal.capture.image().await {
            Ok(image) => image,
            Err(error) => {
                self.invalidate().await;
                return Err(error);
            }
        };
        if self.latest.as_ref().is_some_and(|f| {
            f.capture_generation != image.generation
                || f.input_generation != self.input_generation()
        }) {
            self.release_input().await;
        }
        let base = match &self.portal.backend {
            InputBackend::Direct(direct) => Some(direct.geometry()?),
            InputBackend::Eis(eis) => match self.portal.stream.mapping_id() {
                Some(mapping) => match eis.geometry(mapping).await {
                    Ok(geometry) => Some(geometry),
                    Err(error) if error.code == "mapping-unavailable" => None,
                    Err(error) => return Err(error),
                },
                None => None,
            },
            InputBackend::Notify { .. } if image.generation > 1 => None,
            _ => self
                .portal
                .stream
                .size()
                .filter(|(w, h)| *w > 0 && *h > 0)
                .map(|(width, height)| {
                    let (x, y) = self.portal.stream.position().unwrap_or((0, 0));
                    Geometry {
                        x: f64::from(x),
                        y: f64::from(y),
                        width: f64::from(width),
                        height: f64::from(height),
                    }
                }),
        };
        if let Err(error) = self.ensure_live() {
            self.invalidate().await;
            return Err(error);
        }
        if image.generation != self.portal.capture.generation.load(Ordering::Acquire)
            || input_generation != self.input_generation()
        {
            self.invalidate().await;
            return Err(Failure::new(
                "stale-frame",
                "Capture or input geometry changed while capturing",
            ));
        }
        // videoflip normalizes orientation; crop offsets remain stream-relative
        let logical = base.map(|base| Geometry {
            x: base.x
                + f64::from(image.geometry.x) / f64::from(image.geometry.full_width) * base.width,
            y: base.y
                + f64::from(image.geometry.y) / f64::from(image.geometry.full_height) * base.height,
            width: f64::from(image.geometry.width) / f64::from(image.geometry.full_width)
                * base.width,
            height: f64::from(image.geometry.height) / f64::from(image.geometry.full_height)
                * base.height,
        });
        let mapping_id = match &self.portal.backend {
            InputBackend::Direct(d) => Some(format!("wayland-output:{}", d.output_name)),
            _ => self.portal.stream.mapping_id().map(str::to_owned),
        };
        let frame = Frame {
            session_id: self.id.clone(),
            stream_id: self.portal.stream.pipe_wire_node_id().to_string(),
            frame_id: uuid::Uuid::new_v4().to_string(),
            source: self.source.clone(),
            width: image.geometry.width,
            height: image.geometry.height,
            bytes: image.png.len(),
            logical_geometry: logical,
            transform: 0,
            mapping_id,
        };
        self.latest = Some(Latest {
            frame: frame.clone(),
            geometry: image.geometry,
            capture_generation: image.generation,
            input_generation: self.input_generation(),
        });
        Ok((frame, image.png))
    }
    fn point(&self, point: &Point) -> Result<(f64, f64)> {
        self.ensure_live()?;
        if self.invalidated() {
            return Err(Failure::new(
                "stale-frame",
                "Frame or geometry generation is stale",
            ));
        }
        let latest = self
            .latest
            .as_ref()
            .ok_or_else(|| Failure::new("stale-frame", "Capture a fresh frame before input"))?;
        if latest.frame.logical_geometry.is_none() {
            return Err(Failure::new(
                "mapping-unavailable",
                "Captured source has no authoritative input geometry",
            ));
        }
        if point.x < 0.0
            || point.y < 0.0
            || point.x >= f64::from(latest.frame.width)
            || point.y >= f64::from(latest.frame.height)
        {
            return Err(Failure::new(
                "invalid-request",
                "Pointer point is outside the captured frame",
            ));
        }
        Ok((
            (point.x + f64::from(latest.geometry.x)) / f64::from(latest.geometry.full_width),
            (point.y + f64::from(latest.geometry.y)) / f64::from(latest.geometry.full_height),
        ))
    }
    async fn motion(&mut self, point: &Point) -> Result<()> {
        let (x, y) = self.point(point)?;
        self.submitted = true;
        match &mut self.portal.backend {
            InputBackend::Eis(eis) => {
                eis.motion(
                    self.portal.stream.mapping_id().ok_or_else(|| {
                        Failure::new("mapping-unavailable", "Portal omitted EI mapping identity")
                    })?,
                    x,
                    y,
                )
                .await
            }
            InputBackend::Direct(direct) => direct.send(direct::Command::Motion(x, y)).await,
            InputBackend::Notify { proxy, .. } => {
                let Handle::Remote(session, _) = &self.portal.handle else {
                    return Err(Failure::new("closed-session", "No control session"));
                };
                let (w, h) = self.portal.stream.size().ok_or_else(|| {
                    Failure::new("mapping-unavailable", "Portal omitted logical stream size")
                })?;
                proxy
                    .notify_pointer_motion_absolute(
                        session,
                        self.portal.stream.pipe_wire_node_id(),
                        x * f64::from(w),
                        y * f64::from(h),
                        Default::default(),
                    )
                    .await
                    .map_err(Into::into)
            }
            InputBackend::None => Err(Failure::new(
                "authorization-required",
                "Capture-only session has no input authorization",
            )),
        }
    }
    async fn button(&mut self, code: u32, pressed: bool) -> Result<()> {
        self.ensure_live()?;
        if self.invalidated() {
            return Err(Failure::new(
                "stale-frame",
                "Frame or geometry generation is stale",
            ));
        }
        self.submitted = true;
        match &mut self.portal.backend {
            InputBackend::Eis(eis) => eis.button(code, pressed).await,
            InputBackend::Direct(direct) => {
                direct.send(direct::Command::Button(code, pressed)).await
            }
            InputBackend::Notify { proxy, buttons, .. } => {
                let Handle::Remote(session, _) = &self.portal.handle else {
                    return Err(Failure::new("closed-session", "No control session"));
                };
                if pressed {
                    buttons.insert(code);
                }
                proxy
                    .notify_pointer_button(
                        session,
                        code as i32,
                        if pressed {
                            KeyState::Pressed
                        } else {
                            KeyState::Released
                        },
                        Default::default(),
                    )
                    .await?;
                if !pressed {
                    buttons.remove(&code);
                }
                Ok(())
            }
            InputBackend::None => Err(Failure::new("authorization-required", "No control session")),
        }
    }
    async fn key(&mut self, code: u32, pressed: bool) -> Result<()> {
        self.ensure_live()?;
        self.submitted = true;
        match &mut self.portal.backend {
            InputBackend::Eis(eis) => eis.key(code, pressed).await,
            InputBackend::Direct(direct) => direct.send(direct::Command::Key(code, pressed)).await,
            InputBackend::Notify { proxy, keys, .. } => {
                let Handle::Remote(session, _) = &self.portal.handle else {
                    return Err(Failure::new("closed-session", "No control session"));
                };
                if pressed {
                    keys.insert(code);
                }
                proxy
                    .notify_keyboard_keysym(
                        session,
                        code as i32,
                        if pressed {
                            KeyState::Pressed
                        } else {
                            KeyState::Released
                        },
                        Default::default(),
                    )
                    .await?;
                if !pressed {
                    keys.remove(&code);
                }
                Ok(())
            }
            InputBackend::None => Err(Failure::new("authorization-required", "No control session")),
        }
    }
    async fn scroll(&mut self, x: f64, y: f64) -> Result<()> {
        self.ensure_live()?;
        if self.invalidated() {
            return Err(Failure::new(
                "stale-frame",
                "Frame or geometry generation is stale",
            ));
        }
        self.submitted = true;
        match &mut self.portal.backend {
            InputBackend::Eis(eis) => eis.scroll(x, y).await,
            InputBackend::Direct(direct) => direct.send(direct::Command::Scroll(x, y)).await,
            InputBackend::Notify { proxy, .. } => {
                let Handle::Remote(session, _) = &self.portal.handle else {
                    return Err(Failure::new("closed-session", "No control session"));
                };
                proxy
                    .notify_pointer_axis(session, x, y, Default::default())
                    .await?;
                proxy
                    .notify_pointer_axis(
                        session,
                        0.0,
                        0.0,
                        NotifyPointerAxisOptions::default().set_finish(true),
                    )
                    .await?;
                Ok(())
            }
            InputBackend::None => Err(Failure::new("authorization-required", "No control session")),
        }
    }
    async fn keys(&self, chord: Option<&str>) -> Result<Vec<u32>> {
        let symbols = chord_symbols(chord)?;
        if symbols.is_empty() {
            return Ok(symbols);
        }
        match &self.portal.backend {
            InputBackend::Eis(eis) => eis.resolve(&symbols).await,
            InputBackend::Direct(direct) => direct.resolve(&symbols),
            _ => Ok(symbols),
        }
    }
    pub async fn input(&mut self, input: Input) -> Result<Option<Receipt>> {
        let is_text = matches!(&input.action, Action::TypeText(_));
        if is_text {
            if self.last_receipt.is_none() {
                self.reset_receipt();
            }
        } else {
            self.last_receipt = None;
        }
        self.submitted = false;
        let live = self.portal.live.clone();
        let stopped = self.portal.capture.stopped.clone();
        let capture_generation = self.portal.capture.generation.clone();
        let capture_before = capture_generation.load(Ordering::Acquire);
        let input_generation = match &self.portal.backend {
            InputBackend::Eis(e) => Some(e.generation.clone()),
            InputBackend::Direct(d) => Some(d.generation.clone()),
            _ => None,
        };
        let input_before = input_generation.as_ref().map(|g| g.load(Ordering::Acquire));
        let pointer = input.action.pointer();
        let result = tokio::select! {
            biased;
            _ = stopped.cancelled() => Err(Failure::new("disconnected", "PipeWire stream stopped")),
            result = self.perform(input) => result,
            error = async {
                let mut interval = tokio::time::interval(Duration::from_millis(25));
                loop {
                    interval.tick().await;
                    if !live.load(Ordering::Acquire) {
                        break Failure::new("closed-session", "Portal revoked the session");
                    }
                    if input_generation.as_ref().map(|g| g.load(Ordering::Acquire)) != input_before
                        || (pointer && capture_generation.load(Ordering::Acquire) != capture_before)
                    {
                        break Failure::new(
                            "stale-frame",
                            "Input device or capture geometry changed during the action",
                        );
                    }
                }
            } => Err(error),
        };
        let result = result.and_then(|receipt| {
            self.ensure_live()?;
            Ok(receipt)
        });
        match result {
            Err(mut error) => {
                self.release_input().await;
                if is_text && error.receipt.is_none() {
                    error.receipt = self.receipt();
                }
                if self.submitted && !is_text {
                    error.message = format!(
                        "{}: {}. Input may already have been submitted",
                        error.code, error.message
                    );
                    error.code = "partial-input";
                }
                Err(error)
            }
            ok => ok,
        }
    }
    async fn perform(&mut self, input: Input) -> Result<Option<Receipt>> {
        input.action.validate()?;
        if input.session_id != self.id {
            return Err(Failure::new(
                "closed-session",
                "Session is not owned by this channel",
            ));
        }
        if !self.control() {
            return Err(Failure::new(
                "authorization-required",
                "Authorize a combined session and capture again",
            ));
        }
        self.ensure_live()?;
        if input.action.pointer() {
            let latest = self
                .latest
                .as_ref()
                .ok_or_else(|| Failure::new("stale-frame", "No current actionable frame"))?;
            let reference = input.frame.as_ref().ok_or_else(|| {
                Failure::new(
                    "invalid-request",
                    "Pointer actions require frame identifiers",
                )
            })?;
            if reference.frame_id != latest.frame.frame_id
                || reference.stream_id != latest.frame.stream_id
                || self.invalidated()
            {
                return Err(Failure::new(
                    "stale-frame",
                    "Frame or geometry generation is stale",
                ));
            }
            if latest.frame.logical_geometry.is_none() {
                return Err(Failure::new(
                    "mapping-unavailable",
                    "Captured source has no authoritative input geometry",
                ));
            }
            if let InputBackend::Eis(eis) = &self.portal.backend {
                eis.mapping(self.portal.stream.mapping_id().ok_or_else(|| {
                    Failure::new("mapping-unavailable", "Portal omitted EI mapping identity")
                })?)
                .await?;
            }
            match &input.action {
                Action::Drag(a) => {
                    for point in &a.path {
                        self.point(point)?;
                    }
                }
                Action::DragStart(a) | Action::DragMove(a) => {
                    self.point(&a.point)?;
                }
                _ => {}
            }
            match &input.action {
                Action::Click(a) => {
                    self.point(&Point { x: a.x, y: a.y })?;
                }
                Action::Move(a) => {
                    self.point(&Point { x: a.x, y: a.y })?;
                }
                Action::Scroll(a) => {
                    if let (Some(x), Some(y)) = (a.x, a.y) {
                        self.point(&Point { x, y })?;
                    }
                }
                _ => {}
            }
        }
        match &input.action {
            Action::DragMove(a) if self.drag.as_deref() != Some(&a.handle_id) => {
                return Err(Failure::new("invalid-request", "Drag handle is not active"));
            }
            Action::DragEnd(a) if self.drag.as_deref() != Some(&a.handle_id) => {
                return Err(Failure::new("invalid-request", "Drag handle is not active"));
            }
            Action::DragMove(_) | Action::DragEnd(_) => {}
            _ if self.drag.is_some() => {
                return Err(Failure::new("busy", "A drag is already active"));
            }
            _ => {}
        }
        if let Action::TypeText(text) = input.action {
            return self.text(text).await.map(Some);
        }
        let keys = self.keys(input.action.chord()).await?;
        for code in &keys {
            self.key(*code, true).await?;
        }
        match input.action {
            Action::Click(a) => {
                self.motion(&Point { x: a.x, y: a.y }).await?;
                let code = match a.mouse_button.as_deref() {
                    Some("r" | "right") => 273,
                    Some("m" | "middle") => 274,
                    _ => 272,
                };
                for _ in 0..a.click_count.unwrap_or(1) {
                    self.button(code, true).await?;
                    hold(a.duration).await?;
                    self.button(code, false).await?;
                }
            }
            Action::Move(a) => self.motion(&Point { x: a.x, y: a.y }).await?,
            Action::PressKey(a) => hold(a.duration).await?,
            Action::Scroll(a) => {
                if let (Some(x), Some(y)) = (a.x, a.y) {
                    self.motion(&Point { x, y }).await?;
                }
                let amount = a.pixels.unwrap_or(100.0);
                let (x, y) = match a.direction.as_str() {
                    "u" | "up" => (0.0, -amount),
                    "d" | "down" => (0.0, amount),
                    "l" | "left" => (-amount, 0.0),
                    _ => (amount, 0.0),
                };
                self.scroll(x, y).await?;
            }
            Action::Drag(a) => {
                self.motion(&a.path[0]).await?;
                self.button(272, true).await?;
                for point in &a.path[1..] {
                    self.motion(point).await?;
                }
                self.button(272, false).await?;
            }
            Action::DragStart(a) => {
                self.motion(&a.point).await?;
                self.button(272, true).await?;
                self.drag = Some(a.handle_id);
            }
            Action::DragMove(a) => self.motion(&a.point).await?,
            Action::DragEnd(_) => {
                self.button(272, false).await?;
                self.drag = None;
            }
            Action::TypeText(_) => unreachable!(),
        }
        for code in keys.iter().rev() {
            self.key(*code, false).await?;
        }
        Ok(None)
    }
    async fn text(&mut self, input: TypeText) -> Result<Receipt> {
        let mut receipt = Receipt::default();
        if input.text.is_empty() {
            return Ok(receipt);
        }
        if let InputBackend::Eis(eis) = &self.portal.backend
            && eis.has_text().await
        {
            receipt.mechanism = "ei-text";
            self.set_receipt(&receipt);
            let mut remaining = input.text.as_str();
            while !remaining.is_empty() {
                let mut end = remaining.len().min(254);
                while !remaining.is_char_boundary(end) {
                    end -= 1;
                }
                receipt.partial = true;
                self.set_receipt(&receipt);
                if let Err(mut error) = eis.text(&remaining[..end]).await {
                    receipt.partial = receipt.submitted_bytes > 0 || error.code == "partial-input";
                    error.receipt = Some(receipt);
                    return Err(error);
                }
                receipt.submitted_bytes += end;
                receipt.partial = false;
                self.set_receipt(&receipt);
                remaining = &remaining[end..];
            }
            return Ok(receipt);
        }
        let keys = self
            .keys(Some(input.paste_key.as_deref().unwrap_or("Ctrl+v")))
            .await?;
        let effects = self
            .last_receipt
            .clone()
            .ok_or_else(|| Failure::new("backend-error", "Text effect receipt missing"))?;
        let (owner, mechanism) = clipboard::publish(&self.portal, &input.text, effects).await?;
        receipt.mechanism = mechanism;
        receipt.clipboard_changed = true;
        receipt.partial = true;
        self.set_receipt(&receipt);
        self.clipboard = Some(owner);
        let submitted = async {
            for key in &keys {
                self.key(*key, true).await?;
            }
            for key in keys.iter().rev() {
                self.key(*key, false).await?;
            }
            Ok::<(), Failure>(())
        }
        .await;
        if let Err(mut error) = submitted {
            receipt.partial = true;
            error.receipt = Some(receipt);
            return Err(error);
        }
        receipt.submitted_bytes = input.text.len();
        receipt.partial = false;
        self.set_receipt(&receipt);
        Ok(receipt)
    }
    pub async fn release_input(&mut self) {
        self.drag = None;
        match &mut self.portal.backend {
            InputBackend::Eis(eis) => eis.release().await,
            InputBackend::Direct(direct) => {
                let _ = direct.send(direct::Command::Release).await;
            }
            InputBackend::Notify {
                proxy,
                keys,
                buttons,
            } => {
                if let Handle::Remote(session, closed) = &self.portal.handle {
                    if closed.load(Ordering::Acquire) {
                        keys.clear();
                        buttons.clear();
                        return;
                    }
                    for code in keys.drain() {
                        let _ = proxy
                            .notify_keyboard_keysym(
                                session,
                                code as i32,
                                KeyState::Released,
                                Default::default(),
                            )
                            .await;
                    }
                    for code in buttons.drain() {
                        let _ = proxy
                            .notify_pointer_button(
                                session,
                                code as i32,
                                KeyState::Released,
                                Default::default(),
                            )
                            .await;
                    }
                }
            }
            InputBackend::None => {}
        }
    }
}

async fn hold(duration: Option<f64>) -> Result<()> {
    let duration = Duration::try_from_secs_f64(duration.unwrap_or(0.0) / 1000.0)
        .map_err(|e| Failure::new("invalid-request", e))?;
    tokio::time::sleep(duration).await;
    Ok(())
}

fn chord_symbols(chord: Option<&str>) -> Result<Vec<u32>> {
    let Some(chord) = chord else {
        return Ok(Vec::new());
    };
    if chord.len() > 1024 {
        return Err(Failure::new("invalid-request", "Key chord exceeds limit"));
    }
    let mut seen = HashSet::new();
    chord
        .split('+')
        .map(|part| {
            let part = part.trim();
            let lower = part.to_ascii_lowercase();
            let name = match lower.as_str() {
                "ctrl" | "control" => "Control_L",
                "alt" => "Alt_L",
                "shift" => "Shift_L",
                "super" | "win" | "cmd" | "command" => "Super_L",
                "meta" => "Meta_L",
                "enter" => "Return",
                "esc" => "Escape",
                "space" => "space",
                _ => part,
            };
            let symbol = xkb::keysym_from_name(name, xkb::KEYSYM_NO_FLAGS).raw();
            if symbol == 0 || symbol == 0xffffff || !seen.insert(symbol) {
                return Err(Failure::new(
                    "invalid-request",
                    format!("Unknown or duplicate keysym: {part}"),
                ));
            }
            Ok(symbol)
        })
        .collect()
}
