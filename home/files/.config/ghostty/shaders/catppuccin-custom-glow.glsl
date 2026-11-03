// Shared linear-light effect, with only the screen origin adapted per renderer
// Paper, ink, and glow amounts across the theme brightness range
const float dark_effect_amount = 0.90;
const float light_effect_amount = 0.56;
vec3 srgb_to_linear(vec3 color) {
  return mix(color / 12.92, pow((color + 0.055) / 1.055, vec3(2.4)),
             step(vec3(0.04045), color));
}

// Static paper fibres and uneven printed ink
float paper_hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float paper_noise(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(paper_hash(cell), paper_hash(cell + vec2(1.0, 0.0)), f.x),
             mix(paper_hash(cell + vec2(0.0, 1.0)), paper_hash(cell + vec2(1.0)), f.x),
             f.y);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 sample_uv = fragCoord / iResolution.xy;
  vec2 screen_uv = sample_uv;
  @GHOSTTY_Y_FLIP @

      vec4 terminal = texture(iChannel0, sample_uv);
  // Ghostty's semantic uniforms are sRGB even when the texture is linear
  vec3 background = srgb_to_linear(iBackgroundColor);
  vec3 pink = srgb_to_linear(iPalette[5]);
  // Ghostty refreshes these uniforms when its active theme changes
  float background_level =
      clamp(dot(iBackgroundColor, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
  float effect_amount = mix(dark_effect_amount, light_effect_amount, background_level);
  vec3 paper_axis = iForegroundColor - iBackgroundColor;
  paper_axis /=
      max(max(max(abs(paper_axis.x), abs(paper_axis.y)), abs(paper_axis.z)), 0.001);
  vec3 print_ink = srgb_to_linear(mix(iForegroundColor, iPalette[5], 0.25));

  // A broad pink corner light fades before the central reading area
  vec2 pink_distance = screen_uv - vec2(1.0, 1.0);
  float pink_pool = exp(-7.0 * dot(pink_distance, pink_distance));
  float strength = 0.004 + 0.0065 * background_level;

  // Protect text, selections, and distinct TUI backgrounds from the tint
  float background_weight =
      1.0 - smoothstep(0.015, 0.12, length(terminal.rgb - background));
  // Crossing short fibres avoid the straight streaks of fabric or wood
  // Keep the texture anchored to the surface rather than the scrolling text
  float paper_scale = 1.045 - 0.365 * background_level;
  vec2 paper_px = screen_uv * iResolution.xy * paper_scale;
  float grain = paper_hash(floor(paper_px)) - 0.5;
  float tooth = paper_noise(paper_px * 0.65) - 0.5;
  vec2 fibre_a = mat2(0.85, 0.52, -0.52, 0.85) * paper_px;
  vec2 fibre_b = mat2(0.94, -0.34, 0.34, 0.94) * paper_px;
  float fibre = 0.55 * paper_noise(fibre_a * vec2(0.35, 0.08)) +
                0.45 * paper_noise(fibre_b * vec2(0.08, 0.35)) - 0.5;

  // Warp the formation marks slightly so the sheet has no regular grain
  vec2 warp = vec2(paper_noise(paper_px / 190.0),
                   paper_noise(paper_px / 170.0 + vec2(37.0, 11.0))) -
              0.5;
  vec2 sheet = paper_px + warp * 22.0;
  float formation = 0.55 * paper_noise(sheet / 80.0) +
                    0.30 * paper_noise(sheet / 230.0) +
                    0.15 * paper_noise(sheet / 510.0) - 0.5;
  // Contrast follows the theme continuously, including intermediate shades
  float paper_strength = 0.40 + 1.45 * background_level;
  float paper = (grain * 0.008 + tooth * 0.008 + fibre * 0.014 + formation * 0.030) *
                paper_strength;
  vec3 paper_delta =
      srgb_to_linear(clamp(iBackgroundColor + paper_axis * paper, 0.0, 1.0)) -
      background;
  vec3 color = terminal.rgb + paper_delta * background_weight;
  color = mix(color, pink, strength * pink_pool * background_weight);

  // A broken rose ink wash gives the grain a printed, slightly worn finish
  float ink_field = 0.5 + formation * 0.65;
  float ink_fleck = smoothstep(0.64, 0.85, tooth + 0.5);
  float ink = ink_field * ink_field + ink_fleck * 0.25;
  float ink_strength =
      0.003 + 0.077 * background_level * background_level * background_level;
  color = mix(color, print_ink, ink * ink_strength * background_weight);
  fragColor = vec4(mix(terminal.rgb, color, effect_amount), terminal.a);
}
