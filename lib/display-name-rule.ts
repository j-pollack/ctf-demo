// Client-safe display name rules. No imports, so a page that shows the field ships nothing else.

// Browsers compile an input's pattern with the v flag, where an unescaped "-" in a class is an
// error that makes them drop the pattern. Escaped, it is valid with the v flag, the u flag or none.
export const DISPLAY_NAME_PATTERN = "[A-Za-z0-9_\\-]{3,24}";
export const DISPLAY_NAME_RULE =
  "Use 3 to 24 letters, digits, hyphens or underscores, with no spaces.";
// The run start refusal; the game shows a link to the account page beside it.
export const NAME_REQUIRED = "Choose a display name on your account page before you start a run.";
