use crate::protocol::{Failure, Result};
use enigo::{Direction, Enigo, Keyboard, Settings};
use smithay_client_toolkit::{
    delegate_dispatch2, delegate_registry,
    output::{OutputHandler, OutputState},
    reexports::{
        calloop::{EventLoop, channel},
        calloop_wayland_source::WaylandSource,
    },
    registry::{ProvidesRegistryState, RegistryState},
    registry_handlers,
    seat::{Capability, SeatHandler, SeatState},
};
use std::{
    collections::{HashMap, HashSet},
    os::unix::fs::FileExt,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};
use tokio::sync::{mpsc, oneshot};
use wayland_client::{
    Connection, Dispatch, Proxy, QueueHandle,
    globals::registry_queue_init,
    protocol::{wl_keyboard, wl_output, wl_pointer, wl_seat},
};
use wayland_protocols_wlr::virtual_pointer::v1::client::{
    zwlr_virtual_pointer_manager_v1::ZwlrVirtualPointerManagerV1,
    zwlr_virtual_pointer_v1::ZwlrVirtualPointerV1,
};
use xkbcommon::xkb;

#[derive(Default)]
struct KeyboardMap {
    layouts: Vec<HashMap<u32, u16>>,
    identity: String,
    group: usize,
    failure: Option<Failure>,
}

#[derive(Clone, Default)]
pub struct Capabilities {
    pub keyboard: bool,
    pub pointer: bool,
    pub clipboard: bool,
}

pub fn discover() -> Result<Capabilities> {
    let connection = Connection::connect_to_env().map_err(|e| Failure::new("prerequisite", e))?;
    let (globals, _) =
        registry_queue_init::<State>(&connection).map_err(|e| Failure::new("disconnected", e))?;
    Ok(globals.contents().with_list(|list| Capabilities {
        keyboard: list
            .iter()
            .any(|g| g.interface == "zwp_virtual_keyboard_manager_v1"),
        pointer: list
            .iter()
            .any(|g| g.interface == "zwlr_virtual_pointer_manager_v1" && g.version >= 2),
        clipboard: list.iter().any(|g| {
            matches!(
                g.interface.as_str(),
                "ext_data_control_manager_v1" | "zwlr_data_control_manager_v1"
            )
        }),
    }))
}

struct State {
    registry: RegistryState,
    outputs: OutputState,
    seats: SeatState,
    selected: Option<wl_output::WlOutput>,
    pointer: Option<ZwlrVirtualPointerV1>,
    keyboard: Option<Enigo>,
    physical_keyboard: Option<wl_keyboard::WlKeyboard>,
    keymap: Arc<std::sync::Mutex<KeyboardMap>>,
    keys: HashSet<u32>,
    buttons: HashSet<u32>,
    generation: Arc<AtomicU64>,
    geometry: Arc<std::sync::Mutex<Option<crate::protocol::Geometry>>>,
    epoch: Instant,
    removed: bool,
}

impl State {
    fn time(&self) -> u32 {
        self.epoch.elapsed().as_millis() as u32
    }
    fn release(&mut self) {
        let time = self.time();
        if let Some(pointer) = &self.pointer {
            for button in self.buttons.drain() {
                pointer.button(time, button, wl_pointer::ButtonState::Released);
            }
            pointer.frame();
        }
        if let Some(keyboard) = &mut self.keyboard {
            for key in self.keys.drain() {
                if let Ok(key) = u16::try_from(key) {
                    let _ = keyboard.raw(key, Direction::Release);
                }
            }
        }
    }
    fn remove_keyboard(&mut self) {
        self.release();
        if let Some(keyboard) = self.physical_keyboard.take() {
            keyboard.release();
        }
        if let Ok(mut map) = self.keymap.lock() {
            *map = KeyboardMap::default();
        }
        self.generation.fetch_add(1, Ordering::AcqRel);
    }
    fn changed(&mut self, output: &wl_output::WlOutput, removed: bool) {
        if self.selected.as_ref() == Some(output) {
            self.release();
            self.removed |= removed;
            if let Ok(mut geometry) = self.geometry.lock() {
                *geometry = if removed {
                    None
                } else {
                    output_geometry(&self.outputs, output)
                };
            }
            self.generation.fetch_add(1, Ordering::AcqRel);
        }
    }
}

impl OutputHandler for State {
    fn output_state(&mut self) -> &mut OutputState {
        &mut self.outputs
    }
    fn new_output(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_output::WlOutput) {}
    fn update_output(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        output: wl_output::WlOutput,
    ) {
        self.changed(&output, false);
    }
    fn output_destroyed(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        output: wl_output::WlOutput,
    ) {
        self.changed(&output, true);
    }
}

impl ProvidesRegistryState for State {
    fn registry(&mut self) -> &mut RegistryState {
        &mut self.registry
    }
    registry_handlers!(OutputState, SeatState);
}
delegate_dispatch2!(State);
delegate_registry!(State);

impl Dispatch<ZwlrVirtualPointerManagerV1, ()> for State {
    fn event(
        _: &mut Self,
        _: &ZwlrVirtualPointerManagerV1,
        _: <ZwlrVirtualPointerManagerV1 as wayland_client::Proxy>::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<ZwlrVirtualPointerV1, ()> for State {
    fn event(
        _: &mut Self,
        _: &ZwlrVirtualPointerV1,
        _: <ZwlrVirtualPointerV1 as wayland_client::Proxy>::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

impl SeatHandler for State {
    fn seat_state(&mut self) -> &mut SeatState {
        &mut self.seats
    }

    fn new_seat(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_seat::WlSeat) {
        if self.seats.seats().count() != 1 {
            self.remove_keyboard();
        }
    }

    fn new_capability(
        &mut self,
        _: &Connection,
        handle: &QueueHandle<Self>,
        seat: wl_seat::WlSeat,
        capability: Capability,
    ) {
        if capability == Capability::Keyboard
            && self.seats.seats().count() == 1
            && seat.version() >= 5
            && self.physical_keyboard.is_none()
        {
            // Keep raw keymap dispatch: SCTK logs parse failures without
            // notifying callers and does not bound keymap size
            self.physical_keyboard = Some(seat.get_keyboard(handle, ()));
        }
    }

    fn remove_capability(
        &mut self,
        _: &Connection,
        _: &QueueHandle<Self>,
        _: wl_seat::WlSeat,
        capability: Capability,
    ) {
        if capability == Capability::Keyboard {
            self.remove_keyboard();
        }
    }

    fn remove_seat(&mut self, _: &Connection, _: &QueueHandle<Self>, _: wl_seat::WlSeat) {
        self.remove_keyboard();
    }
}

impl Dispatch<wl_keyboard::WlKeyboard, ()> for State {
    fn event(
        state: &mut Self,
        keyboard: &wl_keyboard::WlKeyboard,
        event: wl_keyboard::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if state.physical_keyboard.as_ref() != Some(keyboard) {
            return;
        }
        match event {
            wl_keyboard::Event::Keymap { format, fd, size } => {
                let layouts = if matches!(
                    format,
                    wayland_client::WEnum::Value(wl_keyboard::KeymapFormat::XkbV1)
                ) {
                    keyboard_layouts(fd, size)
                } else {
                    Err(Failure::new(
                        "missing-protocol",
                        "Unsupported Wayland keyboard keymap format",
                    ))
                };
                if layouts.as_ref().is_ok_and(|next| {
                    state
                        .keymap
                        .lock()
                        .is_ok_and(|map| map.failure.is_none() && map.identity == next.identity)
                }) {
                    return;
                }
                state.release();
                if let Ok(mut map) = state.keymap.lock() {
                    match layouts {
                        Ok(next) => {
                            map.layouts = next.layouts;
                            map.identity = next.identity;
                            map.failure = None;
                        }
                        Err(error) => {
                            map.layouts.clear();
                            map.failure = Some(error);
                        }
                    }
                }
                state.generation.fetch_add(1, Ordering::AcqRel);
            }
            wl_keyboard::Event::Modifiers { group, .. } => {
                let changed = state
                    .keymap
                    .lock()
                    .is_ok_and(|map| map.group != group as usize);
                if changed {
                    state.release();
                    if let Ok(mut map) = state.keymap.lock() {
                        map.group = group as usize;
                    }
                    state.generation.fetch_add(1, Ordering::AcqRel);
                }
            }
            _ => {}
        }
    }
}

fn keyboard_layouts(fd: std::os::fd::OwnedFd, size: u32) -> Result<KeyboardMap> {
    if size > 16 * 1024 * 1024 {
        return Err(Failure::new(
            "backend-error",
            "Wayland keymap exceeds limit",
        ));
    }
    // SCM_RIGHTS FDs share offsets; leave the compositor's offset unchanged
    let mut bytes = vec![0; size as usize];
    std::fs::File::from(fd)
        .read_exact_at(&mut bytes, 0)
        .map_err(|error| Failure::new("backend-error", error))?;
    let mut text =
        String::from_utf8(bytes).map_err(|error| Failure::new("backend-error", error))?;
    text.truncate(text.trim_end_matches('\0').len());
    let context = xkb::Context::new(xkb::CONTEXT_NO_FLAGS);
    let map = xkb::Keymap::new_from_string(
        &context,
        text,
        xkb::KEYMAP_FORMAT_TEXT_V1,
        xkb::KEYMAP_COMPILE_NO_FLAGS,
    )
    .ok_or_else(|| Failure::new("backend-error", "Invalid Wayland keyboard keymap"))?;
    let mut layouts = Vec::with_capacity(map.num_layouts() as usize);
    for layout in 0..map.num_layouts() {
        let mut symbols = HashMap::new();
        for raw in map.min_keycode().raw()..=map.max_keycode().raw() {
            let Ok(code) = u16::try_from(raw) else {
                continue;
            };
            let key = xkb::Keycode::new(raw);
            for level in 0..map.num_levels_for_key(key, layout) {
                for symbol in map.key_get_syms_by_level(key, layout, level) {
                    symbols.entry(symbol.raw()).or_insert(code);
                }
            }
        }
        layouts.push(symbols);
    }
    Ok(KeyboardMap {
        layouts,
        identity: map.get_as_string(xkb::KEYMAP_FORMAT_TEXT_V1),
        ..Default::default()
    })
}

pub enum Command {
    Motion(f64, f64),
    Button(u32, bool),
    Key(u32, bool),
    Scroll(f64, f64),
    Release,
}

type Request = (Command, oneshot::Sender<Result<()>>);

pub struct Direct {
    sender: mpsc::Sender<Request>,
    _events: tokio_util::sync::DropGuard,
    pub generation: Arc<AtomicU64>,
    geometry: Arc<std::sync::Mutex<Option<crate::protocol::Geometry>>>,
    keymap: Arc<std::sync::Mutex<KeyboardMap>>,
    pub output_name: String,
}

impl Direct {
    pub async fn connect(output_name: &str) -> Result<Self> {
        let connection =
            Connection::connect_to_env().map_err(|e| Failure::new("prerequisite", e))?;
        let (globals, mut queue) = registry_queue_init::<State>(&connection)
            .map_err(|e| Failure::new("disconnected", e))?;
        let handle = queue.handle();
        let generation = Arc::new(AtomicU64::new(0));
        let geometry = Arc::new(std::sync::Mutex::new(None));
        let keymap = Arc::new(std::sync::Mutex::new(KeyboardMap::default()));
        let mut state = State {
            registry: RegistryState::new(&globals),
            outputs: OutputState::new(&globals, &handle),
            seats: SeatState::new(&globals, &handle),
            selected: None,
            pointer: None,
            keyboard: None,
            physical_keyboard: None,
            keymap: keymap.clone(),
            keys: HashSet::new(),
            buttons: HashSet::new(),
            generation: generation.clone(),
            geometry: geometry.clone(),
            epoch: Instant::now(),
            removed: false,
        };
        if state.seats.seats().count() != 1 {
            return Err(Failure::new(
                "mapping-unavailable",
                "Direct keyboard requires one unambiguous Wayland seat",
            ));
        }
        if state.seats.seats().any(|seat| seat.version() < 5) {
            return Err(Failure::new(
                "missing-protocol",
                "Direct keyboard requires Wayland seat version 5 or newer",
            ));
        }
        queue
            .roundtrip(&mut state)
            .map_err(|e| Failure::new("disconnected", e))?;
        queue
            .roundtrip(&mut state)
            .map_err(|error| Failure::new("disconnected", error))?;
        {
            let map = keymap
                .lock()
                .map_err(|_| Failure::new("backend-error", "Keyboard map lock poisoned"))?;
            if let Some(error) = &map.failure {
                return Err(Failure::new(error.code, &error.message));
            }
            if map.layouts.is_empty() {
                return Err(Failure::new(
                    "missing-protocol",
                    "Wayland keyboard keymap is unavailable",
                ));
            }
        }
        let outputs: Vec<_> = state
            .outputs
            .outputs()
            .filter(|o| state.outputs.info(o).and_then(|i| i.name).as_deref() == Some(output_name))
            .collect();
        if outputs.len() != 1 {
            return Err(Failure::new(
                "mapping-unavailable",
                "outputName does not identify exactly one Wayland output",
            ));
        }
        let initial = output_geometry(&state.outputs, &outputs[0]).ok_or_else(|| {
            Failure::new(
                "mapping-unavailable",
                "Selected output has no authoritative logical geometry",
            )
        })?;
        *geometry
            .lock()
            .map_err(|_| Failure::new("backend-error", "Output geometry lock poisoned"))? =
            Some(initial);
        let manager: ZwlrVirtualPointerManagerV1 = globals
            .bind(&handle, 2..=2, ())
            .map_err(|e| Failure::new("missing-protocol", e))?;
        state.pointer =
            Some(manager.create_virtual_pointer_with_output(None, Some(&outputs[0]), &handle, ()));
        state.selected = Some(outputs[0].clone());
        state.keyboard = Some(
            Enigo::new(&Settings::default()).map_err(|e| Failure::new("missing-protocol", e))?,
        );
        queue
            .roundtrip(&mut state)
            .map_err(|error| Failure::new("disconnected", error))?;
        connection
            .flush()
            .map_err(|e| Failure::new("disconnected", e))?;
        let (sender, mut receiver) = mpsc::channel::<Request>(16);
        let (commands, source) = channel::channel::<Request>();
        let (ready, started) = oneshot::channel();
        std::thread::Builder::new()
            .name("omp-wayland-input".into())
            .spawn(move || {
                let mut ready = Some(ready);
                let result = (|| -> Result<()> {
                    let mut events = EventLoop::<State>::try_new()
                        .map_err(|e| Failure::new("disconnected", e))?;
                    WaylandSource::new(connection.clone(), queue)
                        .insert(events.handle())
                        .map_err(|e| Failure::new("disconnected", e.error))?;
                    let output = connection.clone();
                    let stop = events.get_signal();
                    events
                        .handle()
                        .insert_source(source, move |event, _, state| match event {
                            channel::Event::Msg((command, reply)) => {
                                if reply.is_closed() {
                                    return;
                                }
                                let result = apply(state, command).and_then(|()| {
                                    output.flush().map_err(|e| Failure::new("partial-input", e))
                                });
                                let _ = reply.send(result);
                            }
                            channel::Event::Closed => stop.stop(),
                        })
                        .map_err(|e| Failure::new("disconnected", e.error))?;
                    let _ = ready.take().unwrap().send(Ok::<(), Failure>(()));
                    events
                        .run(None, &mut state, |_| {})
                        .map_err(|e| Failure::new("disconnected", e))
                })();
                if let Some(ready) = ready {
                    let _ = ready.send(result);
                }
                state.release();
                let _ = connection.flush();
                state.generation.fetch_add(1, Ordering::AcqRel);
            })
            .map_err(|e| Failure::new("disconnected", e))?;
        started
            .await
            .map_err(|_| Failure::new("disconnected", "Wayland worker failed to start"))??;
        let cancellation = tokio_util::sync::CancellationToken::new();
        let events = cancellation.clone().drop_guard();
        // Forward one request at a time to retain bounded Tokio backpressure;
        // cancellation drops the calloop sender, waking the worker to
        // release input
        tokio::spawn(async move {
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => {},
                _ = async {
                    while let Some((command, reply)) = receiver.recv().await {
                        let (completed, result) = oneshot::channel();
                        if commands.send((command, completed)).is_err() {
                            break;
                        }
                        let Ok(result) = result.await else {
                            break;
                        };
                        let _ = reply.send(result);
                    }
                } => {},
            }
        });
        Ok(Self {
            sender,
            _events: events,
            generation,
            geometry,
            keymap,
            output_name: output_name.to_owned(),
        })
    }
    pub fn geometry(&self) -> Result<crate::protocol::Geometry> {
        self.geometry
            .lock()
            .map_err(|_| Failure::new("backend-error", "Output geometry lock poisoned"))?
            .clone()
            .ok_or_else(|| {
                Failure::new(
                    "mapping-unavailable",
                    "Selected output geometry is unavailable",
                )
            })
    }
    // Resolve against the compositor keymap before pressing modifiers so Enigo
    // does not replace its virtual keymap midway through a shortcut
    pub fn resolve(&self, symbols: &[u32]) -> Result<Vec<u32>> {
        let map = self
            .keymap
            .lock()
            .map_err(|_| Failure::new("backend-error", "Keyboard map lock poisoned"))?;
        if let Some(error) = &map.failure {
            return Err(Failure::new(error.code, &error.message));
        }
        let layout = map.layouts.get(map.group).ok_or_else(|| {
            Failure::new("paused-device", "Wayland keyboard layout is unavailable")
        })?;
        symbols
            .iter()
            .map(|symbol| {
                layout
                    .get(symbol)
                    .map(|code| u32::from(*code))
                    .ok_or_else(|| {
                        Failure::new(
                            "invalid-request",
                            format!("Keysym {symbol:#x} is unavailable in the Wayland keymap"),
                        )
                    })
            })
            .collect()
    }
    pub async fn send(&self, command: Command) -> Result<()> {
        let (sender, receiver) = oneshot::channel();
        self.sender
            .send((command, sender))
            .await
            .map_err(|_| Failure::new("disconnected", "Wayland input disconnected"))?;
        receiver
            .await
            .map_err(|_| Failure::new("disconnected", "Wayland input disconnected"))?
    }
}

fn output_geometry(
    outputs: &OutputState,
    output: &wl_output::WlOutput,
) -> Option<crate::protocol::Geometry> {
    let info = outputs.info(output)?;
    let (x, y) = info.logical_position?;
    let (width, height) = info.logical_size?;
    if width <= 0 || height <= 0 {
        return None;
    }
    Some(crate::protocol::Geometry {
        x: f64::from(x),
        y: f64::from(y),
        width: f64::from(width),
        height: f64::from(height),
    })
}

fn apply(state: &mut State, command: Command) -> Result<()> {
    if matches!(command, Command::Release) {
        state.release();
        return Ok(());
    }
    if state.removed {
        return Err(Failure::new(
            "mapping-unavailable",
            "Selected output was removed",
        ));
    }
    let time = state.time();
    let pointer = state
        .pointer
        .as_ref()
        .ok_or_else(|| Failure::new("disconnected", "Pointer unavailable"))?;
    match command {
        Command::Motion(x, y) => {
            // Output-bound normalized coordinates avoid global origins and scale guesses
            pointer.motion_absolute(
                time,
                (x * 1_000_000.0) as u32,
                (y * 1_000_000.0) as u32,
                1_000_000,
                1_000_000,
            );
            pointer.frame();
        }
        Command::Button(code, pressed) => {
            if pressed {
                state.buttons.insert(code);
            } else {
                state.buttons.remove(&code);
            }
            pointer.button(
                time,
                code,
                if pressed {
                    wl_pointer::ButtonState::Pressed
                } else {
                    wl_pointer::ButtonState::Released
                },
            );
            pointer.frame();
        }
        Command::Scroll(x, y) => {
            pointer.axis_source(wl_pointer::AxisSource::Continuous);
            if x != 0.0 {
                pointer.axis(time, wl_pointer::Axis::HorizontalScroll, x);
            }
            if y != 0.0 {
                pointer.axis(time, wl_pointer::Axis::VerticalScroll, y);
            }
            pointer.frame();
            if x != 0.0 {
                pointer.axis_stop(time, wl_pointer::Axis::HorizontalScroll);
            }
            if y != 0.0 {
                pointer.axis_stop(time, wl_pointer::Axis::VerticalScroll);
            }
            pointer.frame();
        }
        Command::Key(code, pressed) => {
            if pressed {
                state.keys.insert(code);
            } else {
                state.keys.remove(&code);
            }
            state
                .keyboard
                .as_mut()
                .ok_or_else(|| Failure::new("disconnected", "Keyboard unavailable"))?
                .raw(
                    u16::try_from(code)
                        .map_err(|_| Failure::new("invalid-request", "Invalid keyboard keycode"))?,
                    if pressed {
                        Direction::Press
                    } else {
                        Direction::Release
                    },
                )
                .map_err(|e| Failure::new("partial-input", e))?;
        }
        Command::Release => unreachable!(),
    }
    Ok(())
}
