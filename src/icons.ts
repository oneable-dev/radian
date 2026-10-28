// Icon names/code points from Nerd Fonts 3.5.1 glyphnames.json.
const robotOutline = "\u{F167A}";
export const icons = {
  repo: "\uEA62", // nf-cod-repo
  folder: "\uEA83", // nf-cod-folder
  branch: "\uEA68", // nf-cod-source_control
  tag: "\uEA66", // nf-cod-tag
  loading: "\uEB19", // nf-cod-loading
  pass: "\uEAB2", // nf-cod-check
  bell: "\uF0F3", // nf-fa-bell; filled unread indicator
  error: "\uEA76", // nf-cod-close
  failure: "\uF06A", // nf-fa-circle_exclamation; distinct from close controls
  cancelled: "\u25CF", // Unicode black circle; neutral cancelled result
  unknown: "\uEAD9", // nf-cod-dash; unreported/aborted, not a confirmed idle state
  robot: robotOutline, // nf-md-robot_outline; shared by Agent empty states and model metadata
  model: robotOutline, // Semantic alias for model metadata
  terminal: "\uEA85", // nf-cod-terminal
  brain: "\u{F09D1}", // nf-md-brain
  bolt: "\uF0E7", // nf-fa-bolt
  mcp: "\uF1E6", // nf-fa-plug
  context: "\uF1C0", // nf-fa-database
  openai: "\uEC81", // nf-cod-openai
  claude: "\uEC82", // nf-cod-claude
} as const;

export const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
