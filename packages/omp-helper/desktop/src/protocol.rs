use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const MAX_REQUEST: usize = 1024 * 1024;

pub const MAX_RESPONSE: usize = 46 * 1024 * 1024;

pub const MAX_PNG: usize = 32 * 1024 * 1024;

pub const MAX_PIXELS: u64 = 100_000_000;

#[derive(Debug)]
pub struct Failure {
    pub code: &'static str,
    pub message: String,
    pub receipt: Option<Receipt>,
}

pub type Result<T, E = Failure> = std::result::Result<T, E>;

impl Failure {
    pub fn new(code: &'static str, message: impl ToString) -> Self {
        Self {
            code,
            message: message.to_string(),
            receipt: None,
        }
    }
    pub fn value(self) -> Value {
        let mut v = json!({
            "status": "error",
            "code": self.code,
            "message": self.message,
        });
        if let Some(receipt) = self.receipt {
            v["receipt"] = json!(receipt);
        }
        v
    }
}

impl From<ashpd::Error> for Failure {
    fn from(value: ashpd::Error) -> Self {
        let code = match &value {
            ashpd::Error::Response(ashpd::desktop::ResponseError::Cancelled) => "cancelled",
            ashpd::Error::Response(_) => "denied",
            ashpd::Error::Portal(ashpd::PortalError::Cancelled(_)) => "cancelled",
            ashpd::Error::Portal(ashpd::PortalError::NotAllowed(_)) => "denied",
            ashpd::Error::PortalNotFound(_) | ashpd::Error::RequiresVersion(_, _) => {
                "missing-protocol"
            }
            _ => "backend-error",
        };
        Self::new(code, value)
    }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, schemars::JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    #[default]
    Monitor,
    Window,
}

#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrameRef {
    pub stream_id: String,
    pub frame_id: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub mechanism: &'static str,
    pub clipboard_changed: bool,
    pub submitted_bytes: usize,
    pub partial: bool,
}

impl Default for Receipt {
    fn default() -> Self {
        Self {
            mechanism: "none",
            clipboard_changed: false,
            submitted_bytes: 0,
            partial: false,
        }
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct Geometry {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub session_id: String,
    pub stream_id: String,
    pub frame_id: String,
    pub source: Source,
    pub width: u32,
    pub height: u32,
    pub bytes: usize,
    pub logical_geometry: Option<Geometry>,
    pub transform: u32,
    pub mapping_id: Option<String>,
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Empty {}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Open {
    pub uri: String,
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceRelease {
    pub workspace_id: String,
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Authorize {
    pub source: Source,
    pub output_name: Option<String>,
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capture {
    pub session_id: Option<String>,
    pub source: Option<Source>,
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Release {
    pub session_id: Option<String>,
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    pub session_id: String,
    pub frame: Option<FrameRef>,
    pub action: Action,
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "method",
    content = "input",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum Action {
    Click(Click),
    Move(Move),
    PressKey(PressKey),
    TypeText(TypeText),
    Scroll(Scroll),
    Drag(Drag),
    DragStart(DragPoint),
    DragMove(DragPoint),
    DragEnd(DragEnd),
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Click {
    pub x: f64,
    pub y: f64,
    pub click_count: Option<u32>,
    pub duration: Option<f64>,
    pub key: Option<String>,
    pub mouse_button: Option<String>,
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Move {
    pub x: f64,
    pub y: f64,
    pub key: Option<String>,
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct PressKey {
    pub key: String,
    pub duration: Option<f64>,
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct TypeText {
    pub text: String,
    pub paste_key: Option<String>,
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Scroll {
    pub direction: String,
    pub pixels: Option<f64>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub key: Option<String>,
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct Drag {
    pub path: Vec<Point>,
    pub key: Option<String>,
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DragPoint {
    pub handle_id: String,
    pub point: Point,
}
#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct DragEnd {
    pub handle_id: String,
}

impl Action {
    pub fn pointer(&self) -> bool {
        !matches!(self, Self::PressKey(_) | Self::TypeText(_))
    }
    pub fn chord(&self) -> Option<&str> {
        match self {
            Self::Click(a) => a.key.as_deref(),
            Self::Move(a) => a.key.as_deref(),
            Self::PressKey(a) => Some(&a.key),
            Self::Scroll(a) => a.key.as_deref(),
            Self::Drag(a) => a.key.as_deref(),
            _ => None,
        }
    }
    pub fn validate(&self) -> Result<()> {
        let valid_point = |p: &Point| p.x.is_finite() && p.y.is_finite();
        let valid_duration = |v: Option<f64>| {
            v.is_none_or(|v| {
                v.is_finite()
                    && v >= 0.0
                    && std::time::Duration::try_from_secs_f64(v / 1000.0).is_ok()
            })
        };
        let valid = match self {
            Self::Click(a) => {
                valid_point(&Point { x: a.x, y: a.y })
                    && valid_duration(a.duration)
                    && a.click_count != Some(0)
                    && a.mouse_button
                        .as_deref()
                        .is_none_or(|b| matches!(b, "l" | "r" | "m" | "left" | "right" | "middle"))
            }
            Self::Move(a) => valid_point(&Point { x: a.x, y: a.y }),
            Self::PressKey(a) => !a.key.is_empty() && valid_duration(a.duration),
            Self::TypeText(a) => !a.text.contains('\0'),
            Self::Scroll(a) => {
                matches!(
                    a.direction.as_str(),
                    "u" | "d" | "l" | "r" | "up" | "down" | "left" | "right"
                ) && a.x.is_some() == a.y.is_some()
                    && a.x.is_none_or(f64::is_finite)
                    && a.y.is_none_or(f64::is_finite)
                    && valid_duration(a.pixels)
            }
            Self::Drag(a) => a.path.len() >= 2 && a.path.iter().all(valid_point),
            Self::DragStart(a) | Self::DragMove(a) => {
                validate_id(&a.handle_id).is_ok() && valid_point(&a.point)
            }
            Self::DragEnd(a) => validate_id(&a.handle_id).is_ok(),
        };
        if valid {
            Ok(())
        } else {
            Err(Failure::new("invalid-request", "Invalid action parameters"))
        }
    }
}

pub fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|e| Failure::new("invalid-request", e))
}

pub fn validate_id(id: &str) -> Result<()> {
    if id.is_empty() || id.len() > 1024 {
        Err(Failure::new(
            "invalid-request",
            "Identifier must contain 1–1024 bytes",
        ))
    } else {
        Ok(())
    }
}
