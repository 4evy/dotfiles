use crate::protocol::{Failure, MAX_PIXELS, MAX_PNG, Result};
use gst::prelude::*;
use gstreamer as gst;
use gstreamer_app::{AppSink, AppSinkCallbacks, AppSrc};
use gstreamer_video::{VideoCropMeta, VideoInfo};
use std::{
    os::fd::{AsRawFd, OwnedFd},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Geometry {
    pub full_width: u32,
    pub full_height: u32,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

struct Latest {
    sample: Option<gst::Sample>,
    geometry: Option<Geometry>,
    minimum_running_time: Option<gst::ClockTime>,
    failure: Option<Failure>,
}

pub struct Capture {
    pipeline: gst::Pipeline,
    bus: gst::Bus,
    latest: Arc<Mutex<Latest>>,
    pub generation: Arc<AtomicU64>,
    pub stopped: CancellationToken,
    ready: Arc<tokio::sync::Notify>,
    _fd: OwnedFd,
}

pub struct Image {
    pub png: Vec<u8>,
    pub geometry: Geometry,
    pub generation: u64,
}

impl Capture {
    pub fn new(fd: OwnedFd, node: u32) -> Result<Self> {
        gst::init().map_err(|e| Failure::new("prerequisite", e))?;
        let pipeline = gst::parse::launch(&format!(
            "pipewiresrc fd={} path={} do-timestamp=true ! videoconvert ! videoflip video-direction=auto ! video/x-raw,format=RGBA ! appsink name=frames max-buffers=1 drop=true sync=false",
            fd.as_raw_fd(),
            node
        ))
        .map_err(|e| Failure::new("prerequisite", e))?
        .downcast::<gst::Pipeline>()
        .map_err(|_| Failure::new("backend-error", "Capture is not a pipeline"))?;
        let sink = pipeline
            .by_name("frames")
            .and_then(|e| e.downcast::<AppSink>().ok())
            .ok_or_else(|| Failure::new("prerequisite", "GStreamer app sink missing"))?;
        let latest = Arc::new(Mutex::new(Latest {
            sample: None,
            geometry: None,
            minimum_running_time: None,
            failure: None,
        }));
        let generation = Arc::new(AtomicU64::new(0));
        let ready = Arc::new(tokio::sync::Notify::new());
        let stopped = CancellationToken::new();
        let bus = pipeline
            .bus()
            .ok_or_else(|| Failure::new("backend-error", "Capture bus missing"))?;
        let (out, changed, notify, terminal) = (
            latest.clone(),
            generation.clone(),
            ready.clone(),
            stopped.clone(),
        );
        // Observe terminal messages synchronously without a worker or queue
        bus.set_sync_handler(move |_, message| {
            if matches!(
                message.view(),
                gst::MessageView::Error(_) | gst::MessageView::Eos(_)
            ) {
                let mut state = out.lock().unwrap_or_else(|error| error.into_inner());
                if state.failure.is_none() {
                    state.failure = Some(Failure::new(
                        "disconnected",
                        format!("PipeWire stream stopped: {message:?}"),
                    ));
                    state.sample = None;
                    changed.fetch_add(1, Ordering::AcqRel);
                }
                terminal.cancel();
                notify.notify_waiters();
            }
            gst::BusSyncReply::Drop
        });
        let (out, changed, notify) = (latest.clone(), generation.clone(), ready.clone());
        let terminal = stopped.clone();
        sink.set_callbacks(
            AppSinkCallbacks::builder()
                .new_sample(move |sink| {
                    let sample = sink.pull_sample().map_err(|_| gst::FlowError::Eos)?;
                    let caps = sample.caps().ok_or(gst::FlowError::NotNegotiated)?;
                    let info =
                        VideoInfo::from_caps(caps).map_err(|_| gst::FlowError::NotNegotiated)?;
                    let mut geometry = Geometry {
                        full_width: info.width(),
                        full_height: info.height(),
                        x: 0,
                        y: 0,
                        width: info.width(),
                        height: info.height(),
                    };
                    if let Some(crop) = sample.buffer().and_then(|b| b.meta::<VideoCropMeta>()) {
                        let (x, y, width, height) = crop.rect();
                        geometry.x = x;
                        geometry.y = y;
                        geometry.width = width;
                        geometry.height = height;
                    }
                    let mut state = out.lock().map_err(|_| gst::FlowError::Error)?;
                    if state.failure.is_some() {
                        return Err(gst::FlowError::Eos);
                    }
                    if let Some(minimum) = state.minimum_running_time {
                        let running_time = sample.buffer().and_then(|buffer| {
                            sample
                                .segment()?
                                .downcast_ref::<gst::ClockTime>()?
                                .to_running_time(buffer.pts()?)
                        });
                        if running_time.is_none_or(|time| time < minimum) {
                            return Ok(gst::FlowSuccess::Ok);
                        }
                    }
                    if geometry.width == 0
                        || geometry.height == 0
                        || u64::from(geometry.full_width) * u64::from(geometry.full_height)
                            > MAX_PIXELS
                        || geometry
                            .x
                            .checked_add(geometry.width)
                            .is_none_or(|v| v > geometry.full_width)
                        || geometry
                            .y
                            .checked_add(geometry.height)
                            .is_none_or(|v| v > geometry.full_height)
                    {
                        state.failure = Some(Failure::new(
                            "mapping-unavailable",
                            "Capture geometry exceeds safety limits",
                        ));
                        state.sample = None;
                        terminal.cancel();
                        changed.fetch_add(1, Ordering::AcqRel);
                        notify.notify_waiters();
                        return Err(gst::FlowError::Error);
                    }
                    if state.geometry.as_ref() != Some(&geometry) {
                        changed.fetch_add(1, Ordering::AcqRel);
                        state.geometry = Some(geometry);
                    }
                    state.sample = Some(sample);
                    notify.notify_waiters();
                    Ok(gst::FlowSuccess::Ok)
                })
                .build(),
        );
        let capture = Self {
            pipeline,
            bus,
            latest,
            generation,
            stopped,
            ready,
            _fd: fd,
        };
        capture
            .pipeline
            .set_state(gst::State::Playing)
            .map_err(|e| Failure::new("backend-error", e))?;
        Ok(capture)
    }
    pub fn ensure_live(&self) -> Result<()> {
        let state = self
            .latest
            .lock()
            .map_err(|_| Failure::new("backend-error", "Capture lock poisoned"))?;
        if let Some(error) = &state.failure {
            return Err(Failure::new(error.code, &error.message));
        }
        Ok(())
    }
    pub fn discard_sample(&self) -> Result<()> {
        // Fence queued buffers by pipeline time, not callback arrival
        let minimum = self.pipeline.current_running_time().ok_or_else(|| {
            Failure::new(
                "mapping-unavailable",
                "Capture clock is unavailable after input geometry changed",
            )
        })?;
        let mut state = self
            .latest
            .lock()
            .map_err(|_| Failure::new("backend-error", "Capture lock poisoned"))?;
        state.sample = None;
        state.minimum_running_time = Some(minimum);
        self.generation.fetch_add(1, Ordering::AcqRel);
        Ok(())
    }
    pub async fn image(&self) -> Result<Image> {
        let (sample, geometry, generation) = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let pending = self.ready.notified();
                {
                    let state = self
                        .latest
                        .lock()
                        .map_err(|_| Failure::new("backend-error", "Capture lock poisoned"))?;
                    if let Some(error) = &state.failure {
                        return Err(Failure::new(error.code, &error.message));
                    }
                    if let (Some(sample), Some(geometry)) = (&state.sample, &state.geometry) {
                        break Ok((
                            sample.clone(),
                            geometry.clone(),
                            self.generation.load(Ordering::Acquire),
                        ));
                    }
                }
                pending.await;
            }
        })
        .await
        .map_err(|_| Failure::new("disconnected", "No PipeWire frame arrived"))??;
        let image = tokio::select! {
            biased;
            _ = self.stopped.cancelled() => {
                self.ensure_live()?;
                return Err(Failure::new("disconnected", "PipeWire stream stopped"));
            },
            image = tokio::task::spawn_blocking(move || encode(sample, geometry, generation)) =>
                image.map_err(|e| Failure::new("backend-error", e))??,
        };
        self.ensure_live()?;
        Ok(image)
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        let _ = self.pipeline.set_state(gst::State::Null);
        self.bus.unset_sync_handler();
    }
}

fn encode(sample: gst::Sample, geometry: Geometry, generation: u64) -> Result<Image> {
    let pipeline = gst::parse::launch(&format!(
        "appsrc name=source ! videocrop left={} top={} right={} bottom={} ! videoconvert ! pngenc snapshot=true ! appsink name=png max-buffers=1 sync=false",
        geometry.x,
        geometry.y,
        geometry.full_width - geometry.x - geometry.width,
        geometry.full_height - geometry.y - geometry.height
    ))
    .map_err(|e| Failure::new("prerequisite", e))?
    .downcast::<gst::Pipeline>()
    .map_err(|_| Failure::new("backend-error", "Encoder is not a pipeline"))?;
    let result = (|| {
        let source = pipeline
            .by_name("source")
            .and_then(|v| v.downcast::<AppSrc>().ok())
            .ok_or_else(|| Failure::new("prerequisite", "GStreamer app source missing"))?;
        // PNG encoding expects a time segment even for an untimed snapshot
        source.set_format(gst::Format::Time);
        let sink = pipeline
            .by_name("png")
            .and_then(|v| v.downcast::<AppSink>().ok())
            .ok_or_else(|| Failure::new("prerequisite", "PNG sink missing"))?;
        pipeline
            .set_state(gst::State::Playing)
            .map_err(|e| Failure::new("backend-error", e))?;
        source
            .push_sample(&sample)
            .map_err(|e| Failure::new("backend-error", e))?;
        source
            .end_of_stream()
            .map_err(|e| Failure::new("backend-error", e))?;
        let png = sink
            .try_pull_sample(gst::ClockTime::from_seconds(15))
            .ok_or_else(|| Failure::new("backend-error", "PNG encoder timed out"))?;
        let buffer = png
            .buffer()
            .ok_or_else(|| Failure::new("backend-error", "Encoder returned no buffer"))?;
        if buffer.size() > MAX_PNG {
            return Err(Failure::new("backend-error", "PNG exceeds 32 MiB"));
        }
        let bytes = buffer
            .map_readable()
            .map_err(|e| Failure::new("backend-error", e))?;
        Ok(Image {
            png: bytes.as_slice().to_vec(),
            geometry,
            generation,
        })
    })();
    let _ = pipeline.set_state(gst::State::Null);
    result
}
