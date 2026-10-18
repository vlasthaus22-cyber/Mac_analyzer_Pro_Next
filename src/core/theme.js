export const THEME_CHOICES = Object.freeze(["light", "dark"]);

export function isThemeChoice(value) {
  return THEME_CHOICES.includes(value);
}

export function legacyThemeChoice(value) {
  let preference = value;
  if (typeof preference === "string") {
    try { preference = JSON.parse(preference); } catch { /* Some imports may already contain a plain theme name. */ }
  }
  return isThemeChoice(preference) ? preference : "";
}

export function resolveThemeChoice(databaseTheme, localTheme, prefersDark = false) {
  if (isThemeChoice(databaseTheme)) return databaseTheme;
  if (isThemeChoice(localTheme)) return localTheme;
  return prefersDark ? "dark" : "light";
}
