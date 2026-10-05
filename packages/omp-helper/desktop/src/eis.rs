use crate::protocol::{Failure, Result};
use futures_util::StreamExt;
use reis::{
    ei,
    event::{Device, DeviceCapability, EiEvent},
};
use std::{
    collections::{HashMap, HashSet},
    os::{fd::OwnedFd, unix::fs::FileExt},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, Notify};
use xkbcommon::xkb;

struct DeviceState {
    resumed: bool,
    keys: HashSet<u32>,
    buttons: HashSet<u32>,
    started: bool,
    modifiers: [u32; 4],
}

struct State {
    devices: HashMap<Device, DeviceState>,
    failure: Option<&'static str>,
    sequence: u32,
}

pub struct Eis {
    connection: reis::event::Connection,
    state: Arc<Mutex<State>>,
    _events: tokio_util::sync::DropGuard,
    pub generation: Arc<AtomicU64>,
    epoch: Instant,
    ready: Arc<Notify>,
}

impl Eis {
    pub async fn connect(fd: OwnedFd) -> Result<Self> {
        let state = Arc::new(Mutex::new(State {
            devices: HashMap::new(),
            failure: None,
            sequence: 0,
        }));
        let ready = Arc::new(Notify::new());
        let generation = Arc::new(AtomicU64::new(0));
        let (event_state, event_ready, event_generation) =
            (state.clone(), ready.clone(), generation.clone());
        let epoch = Instant::now();
        let cancellation = tokio_util::sync::CancellationToken::new();
        let events = cancellation.clone().drop_guard();
        let (initialized, connection) = tokio::sync::oneshot::channel();
        // The EI converter owns non-Send callbacks, so keep its whole lifetime
        // on one blocking worker while sharing only its thread-safe connection
        tokio::task::spawn_blocking(move || {
            tokio::runtime::Handle::current().block_on(async move {
                let handshake = async {
                    let context = ei::Context::new(std::os::unix::net::UnixStream::from(fd))
                        .map_err(|e| Failure::new("disconnected", e))?;
                    tokio::time::timeout(
                        Duration::from_secs(10),
                        context.handshake_tokio(
                            "io.github.fourevy.OmpHelper",
                            ei::handshake::ContextType::Sender,
                        ),
                    )
                    .await
                    .map_err(|_| Failure::new("disconnected", "EI handshake timed out"))?
                    .map_err(|e| Failure::new("disconnected", e))
                };
                let established = tokio::select! {
                    _ = cancellation.cancelled() => return,
                    result = handshake => result,
                };
                let (event_connection, mut stream) = match established {
                    Ok(established) => established,
                    Err(error) => {
                        let _ = initialized.send(Err(error));
                        return;
                    }
                };
                if initialized.send(Ok(event_connection.clone())).is_err() {
                    return;
                }
                loop {
                    let event = tokio::select! {
                        _ = cancellation.cancelled() => break,
                        event = stream.next() => event,
                    };
                    let Some(event) = event else {
                        break;
                    };
                    let mut state = event_state.lock().await;
                    match event {
                        Ok(EiEvent::SeatAdded(e)) => {
                            // reis emits only advertised capability bits
                            e.seat.bind_capabilities(
                                DeviceCapability::PointerAbsolute
                                    | DeviceCapability::Keyboard
                                    | DeviceCapability::Button
                                    | DeviceCapability::Scroll
                                    | DeviceCapability::Text,
                            );
                            if event_connection.flush().is_err() {
                                state.failure = Some("disconnected");
                                event_generation.fetch_add(1, Ordering::AcqRel);
                                event_ready.notify_waiters();
                                break;
                            }
                        }
                        Ok(EiEvent::DeviceAdded(e)) => {
                            state.devices.insert(
                                e.device,
                                DeviceState {
                                    resumed: false,
                                    keys: HashSet::new(),
                                    buttons: HashSet::new(),
                                    started: false,
                                    modifiers: [0; 4],
                                },
                            );
                        }
                        Ok(EiEvent::DeviceResumed(e)) => {
                            if let Some(d) = state.devices.get_mut(&e.device) {
                                d.resumed = true;
                            }
                            event_generation.fetch_add(1, Ordering::AcqRel);
                            event_ready.notify_waiters();
                        }
                        Ok(EiEvent::DevicePaused(e)) => {
                            for (device, d) in &mut state.devices {
                                if device == &e.device {
                                    // Pause ends this device's emulation on the server
                                    d.keys.clear();
                                    d.buttons.clear();
                                    d.started = false;
                                    d.resumed = false;
                                } else {
                                    release_device(
                                        device,
                                        d,
                                        event_connection.serial(),
                                        epoch.elapsed().as_micros() as u64,
                                    );
                                }
                            }
                            event_generation.fetch_add(1, Ordering::AcqRel);
                        }
                        Ok(EiEvent::DeviceRemoved(e)) => {
                            state.devices.remove(&e.device);
                            for (device, d) in &mut state.devices {
                                release_device(
                                    device,
                                    d,
                                    event_connection.serial(),
                                    epoch.elapsed().as_micros() as u64,
                                );
                            }
                            event_generation.fetch_add(1, Ordering::AcqRel);
                        }
                        Ok(EiEvent::SeatRemoved(e)) => {
                            state.devices.retain(|d, _| d.seat() != &e.seat);
                            for (device, d) in &mut state.devices {
                                release_device(
                                    device,
                                    d,
                                    event_connection.serial(),
                                    epoch.elapsed().as_micros() as u64,
                                );
                            }
                            event_generation.fetch_add(1, Ordering::AcqRel);
                        }
                        Ok(EiEvent::KeyboardModifiers(e)) => {
                            if let Some(d) = state.devices.get_mut(&e.device) {
                                d.modifiers = [e.depressed, e.latched, e.locked, e.group];
                            }
                        }
                        Ok(EiEvent::Disconnected(_)) | Err(_) => {
                            state.failure = Some("disconnected");
                            break;
                        }
                        _ => {}
                    }
                    if event_connection.flush().is_err() {
                        state.failure = Some("disconnected");
                        break;
                    }
                }
                let mut state = event_state.lock().await;
                for (device, d) in &mut state.devices {
                    release_device(
                        device,
                        d,
                        event_connection.serial(),
                        epoch.elapsed().as_micros() as u64,
                    );
                }
                let _ = event_connection.flush();
                state.failure = Some("disconnected");
                event_generation.fetch_add(1, Ordering::AcqRel);
                event_ready.notify_waiters();
            })
        });
        let connection = connection.await.map_err(|_| {
            Failure::new("disconnected", "EI event worker ended during handshake")
        })??;
        let result = Self {
            connection,
            state,
            _events: events,
            generation,
            epoch,
            ready,
        };
        Ok(result)
    }
    pub async fn wait_ready(&self) -> Result<()> {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let notified = self.ready.notified();
                {
                    let state = self.state.lock().await;
                    if let Some(code) = state.failure {
                        return Err(Failure::new(code, "EI session disconnected"));
                    }
                    if state
                        .devices
                        .iter()
                        .any(|(d, s)| s.resumed && d.has_capability(DeviceCapability::Keyboard))
                        && state.devices.iter().any(|(d, s)| {
                            s.resumed && d.has_capability(DeviceCapability::PointerAbsolute)
                        })
                    {
                        return Ok(());
                    }
                }
                notified.await;
            }
        })
        .await
        .map_err(|_| {
            Failure::new(
                "paused-device",
                "No resumed EI keyboard and pointer devices",
            )
        })??;
        Ok(())
    }
    fn time(&self) -> u64 {
        self.epoch.elapsed().as_micros().min(u128::from(u64::MAX)) as u64
    }
    async fn submit(
        &self,
        capability: DeviceCapability,
        operation: impl FnOnce(&Device, &mut DeviceState) -> Result<()>,
    ) -> Result<()> {
        let mut state = self.state.lock().await;
        if let Some(code) = state.failure {
            return Err(Failure::new(code, "EI connection ended"));
        }
        state.sequence = state.sequence.wrapping_add(1);
        let sequence = state.sequence;
        let (device, d) = state
            .devices
            .iter_mut()
            .find(|(device, d)| d.resumed && device.has_capability(capability))
            .ok_or_else(|| Failure::new("paused-device", "No resumed compatible EI device"))?;
        if !d.started {
            device
                .device()
                .start_emulating(self.connection.serial(), sequence);
            d.started = true;
        }
        operation(device, d)?;
        device.device().frame(self.connection.serial(), self.time());
        self.connection
            .flush()
            .map_err(|e| Failure::new("partial-input", e))
    }
    pub async fn mapping(&self, mapping: &str) -> Result<()> {
        let state = self.state.lock().await;
        if let Some(code) = state.failure {
            return Err(Failure::new(code, "EI connection ended"));
        }
        let count = state
            .devices
            .iter()
            .filter(|(d, s)| s.resumed && d.has_capability(DeviceCapability::PointerAbsolute))
            .flat_map(|(d, _)| d.regions())
            .filter(|r| r.mapping_id.as_deref() == Some(mapping))
            .count();
        if count != 1 {
            return Err(Failure::new(
                "mapping-unavailable",
                "Stream has no unique resumed EI region",
            ));
        }
        Ok(())
    }
    pub async fn geometry(&self, mapping: &str) -> Result<crate::protocol::Geometry> {
        self.mapping(mapping).await?;
        let state = self.state.lock().await;
        let region = state
            .devices
            .iter()
            .filter(|(_, s)| s.resumed)
            .flat_map(|(device, _)| device.regions())
            .find(|region| region.mapping_id.as_deref() == Some(mapping))
            .ok_or_else(|| Failure::new("mapping-unavailable", "EI region changed"))?;
        Ok(crate::protocol::Geometry {
            x: f64::from(region.x),
            y: f64::from(region.y),
            width: f64::from(region.width),
            height: f64::from(region.height),
        })
    }
    pub async fn motion(&self, mapping: &str, x: f64, y: f64) -> Result<()> {
        let mut state = self.state.lock().await;
        if let Some(code) = state.failure {
            return Err(Failure::new(code, "EI connection ended"));
        }
        state.sequence = state.sequence.wrapping_add(1);
        let sequence = state.sequence;
        let (device, d) = state
            .devices
            .iter_mut()
            .find(|(d, s)| {
                s.resumed
                    && d.has_capability(DeviceCapability::PointerAbsolute)
                    && d.regions()
                        .iter()
                        .any(|r| r.mapping_id.as_deref() == Some(mapping))
            })
            .ok_or_else(|| {
                Failure::new(
                    "mapping-unavailable",
                    "Stream EI region is no longer resumed",
                )
            })?;
        let r = device
            .regions()
            .iter()
            .find(|r| r.mapping_id.as_deref() == Some(mapping))
            .ok_or_else(|| Failure::new("mapping-unavailable", "EI region removed"))?;
        if !d.started {
            device
                .device()
                .start_emulating(self.connection.serial(), sequence);
            d.started = true;
        }
        device
            .interface::<ei::PointerAbsolute>()
            .ok_or_else(|| Failure::new("paused-device", "EI pointer removed"))?
            .motion_absolute(
                (f64::from(r.x) + x * f64::from(r.width)) as f32,
                (f64::from(r.y) + y * f64::from(r.height)) as f32,
            );
        device.device().frame(self.connection.serial(), self.time());
        self.connection
            .flush()
            .map_err(|e| Failure::new("partial-input", e))
    }
    pub async fn button(&self, code: u32, pressed: bool) -> Result<()> {
        self.submit(DeviceCapability::Button, |device, d| {
            let button = device
                .interface::<ei::Button>()
                .ok_or_else(|| Failure::new("paused-device", "EI button removed"))?;
            if pressed {
                d.buttons.insert(code);
            }
            button.button(
                code,
                if pressed {
                    ei::button::ButtonState::Press
                } else {
                    ei::button::ButtonState::Released
                },
            );
            Ok(())
        })
        .await?;
        if !pressed {
            for state in self.state.lock().await.devices.values_mut() {
                state.buttons.remove(&code);
            }
        }
        Ok(())
    }
    pub async fn scroll(&self, x: f64, y: f64) -> Result<()> {
        self.submit(DeviceCapability::Scroll, |device, _| {
            let scroll = device
                .interface::<ei::Scroll>()
                .ok_or_else(|| Failure::new("paused-device", "EI scroll removed"))?;
            scroll.scroll(x as f32, y as f32);
            Ok(())
        })
        .await?;
        self.submit(DeviceCapability::Scroll, |device, _| {
            device
                .interface::<ei::Scroll>()
                .ok_or_else(|| Failure::new("paused-device", "EI scroll removed"))?
                .scroll_stop(u32::from(x != 0.0), u32::from(y != 0.0), 0);
            Ok(())
        })
        .await
    }
    pub async fn resolve(&self, symbols: &[u32]) -> Result<Vec<u32>> {
        let state = self.state.lock().await;
        let (device, active) = state
            .devices
            .iter()
            .find(|(d, s)| s.resumed && d.has_capability(DeviceCapability::Keyboard))
            .ok_or_else(|| Failure::new("paused-device", "No resumed EI keyboard"))?;
        let keymap = device
            .keymap()
            .ok_or_else(|| Failure::new("missing-protocol", "EI keyboard supplied no keymap"))?;
        let file = std::fs::File::from(
            keymap
                .fd
                .try_clone()
                .map_err(|e| Failure::new("backend-error", e))?,
        );
        if keymap.size > 16 * 1024 * 1024 {
            return Err(Failure::new("backend-error", "EI keymap exceeds limit"));
        }
        // SCM_RIGHTS FDs share offsets; leave the compositor's offset unchanged
        let mut bytes = vec![0; keymap.size as usize];
        file.read_exact_at(&mut bytes, 0)
            .map_err(|e| Failure::new("backend-error", e))?;
        let mut text = String::from_utf8(bytes).map_err(|e| Failure::new("backend-error", e))?;
        text.truncate(text.trim_end_matches('\0').len());
        let context = xkb::Context::new(xkb::CONTEXT_NO_FLAGS);
        let map = xkb::Keymap::new_from_string(
            &context,
            text,
            xkb::KEYMAP_FORMAT_TEXT_V1,
            xkb::KEYMAP_COMPILE_NO_FLAGS,
        )
        .ok_or_else(|| Failure::new("backend-error", "Invalid EI keyboard keymap"))?;
        let mut result = Vec::with_capacity(symbols.len());
        let mut current = xkb::State::new(&map);
        current.update_mask(
            active.modifiers[0],
            active.modifiers[1],
            active.modifiers[2],
            0,
            0,
            active.modifiers[3],
        );
        for symbol in symbols {
            let code = (map.min_keycode().raw()..=map.max_keycode().raw())
                .find(|raw| {
                    let key = xkb::Keycode::new(*raw);
                    current.key_get_one_sym(key).raw() == *symbol
                        || map
                            .key_get_syms_by_level(key, active.modifiers[3], 0)
                            .iter()
                            .any(|s| s.raw() == *symbol)
                })
                .ok_or_else(|| {
                    Failure::new(
                        "invalid-request",
                        format!(
                            "Keysym {symbol:#x} is unavailable in the EI keymap's active chord"
                        ),
                    )
                })?;
            current.update_key(xkb::Keycode::new(code), xkb::KeyDirection::Down);
            result.push(
                code.checked_sub(8)
                    .ok_or_else(|| Failure::new("backend-error", "Invalid XKB keycode"))?,
            );
        }
        Ok(result)
    }
    pub async fn key(&self, code: u32, pressed: bool) -> Result<()> {
        self.submit(DeviceCapability::Keyboard, |device, d| {
            let keyboard = device
                .interface::<ei::Keyboard>()
                .ok_or_else(|| Failure::new("paused-device", "EI keyboard removed"))?;
            if pressed {
                d.keys.insert(code);
            }
            keyboard.key(
                code,
                if pressed {
                    ei::keyboard::KeyState::Press
                } else {
                    ei::keyboard::KeyState::Released
                },
            );
            Ok(())
        })
        .await?;
        if !pressed {
            for state in self.state.lock().await.devices.values_mut() {
                state.keys.remove(&code);
            }
        }
        Ok(())
    }
    pub async fn has_text(&self) -> bool {
        self.state
            .lock()
            .await
            .devices
            .keys()
            .any(|d| d.has_capability(DeviceCapability::Text))
    }
    pub async fn text(&self, text: &str) -> Result<()> {
        self.submit(DeviceCapability::Text, |device, _| {
            device
                .interface::<ei::Text>()
                .ok_or_else(|| Failure::new("paused-device", "EI text removed"))?
                .utf8(text);
            Ok(())
        })
        .await
    }
    pub async fn release(&self) {
        let mut state = self.state.lock().await;
        for (device, d) in &mut state.devices {
            release_device(device, d, self.connection.serial(), self.time());
        }
        let _ = self.connection.flush();
    }
}

fn release_device(device: &Device, d: &mut DeviceState, serial: u32, time: u64) {
    if !d.resumed || !device.device().is_alive() {
        d.keys.clear();
        d.buttons.clear();
        d.started = false;
        return;
    }
    if !d.started {
        return;
    }
    if let Some(keyboard) = device.interface::<ei::Keyboard>() {
        for code in d.keys.drain() {
            keyboard.key(code, ei::keyboard::KeyState::Released);
        }
    }
    if let Some(button) = device.interface::<ei::Button>() {
        for code in d.buttons.drain() {
            button.button(code, ei::button::ButtonState::Released);
        }
    }
    device.device().frame(serial, time);
    device.device().stop_emulating(serial);
    d.started = false;
}
