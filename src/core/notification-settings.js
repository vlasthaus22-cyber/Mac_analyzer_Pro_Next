export const NOTIFICATION_CHANNELS = Object.freeze(["email", "telegram", "slack"]);
export const DEFAULT_NOTIFICATION_SETTINGS = Object.freeze({
  email: Object.freeze({ enabled: false, host: "", port: 587, security: "starttls", username: "", sender: "", recipients: [] }),
  telegram: Object.freeze({ enabled: false, chatId: "" }),
  slack: Object.freeze({ enabled: false }),
});

function text(value, maximum) {
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, maximum);
}

export function normalizeNotificationSettings(value) {
  const channels = value?.channels && typeof value.channels === "object" ? value.channels : {};
  const email = channels.email && typeof channels.email === "object" ? channels.email : {};
  const telegram = channels.telegram && typeof channels.telegram === "object" ? channels.telegram : {};
  const slack = channels.slack && typeof channels.slack === "object" ? channels.slack : {};
  const port = Number(email.port);
  return {
    channels: {
      email: {
        enabled: email.enabled === true,
        host: text(email.host, 253).toLowerCase(),
        port: Number.isFinite(port) ? Math.max(1, Math.min(65_535, Math.trunc(port))) : 587,
        security: email.security === "ssl" ? "ssl" : "starttls",
        username: text(email.username, 254),
        sender: text(email.sender, 254),
        recipients: (Array.isArray(email.recipients) ? email.recipients : []).map((item) => text(item, 254)).filter(Boolean).slice(0, 20),
      },
      telegram: { enabled: telegram.enabled === true, chatId: text(telegram.chatId, 128) },
      slack: { enabled: slack.enabled === true },
    },
    secretsConfigured: Object.fromEntries(NOTIFICATION_CHANNELS.map((channel) => [channel, value?.secretsConfigured?.[channel] === true])),
  };
}

export function normalizeNotificationSecret(channel, value) {
  if (!NOTIFICATION_CHANNELS.includes(channel)) return {};
  const fields = { email: ["password"], telegram: ["botToken"], slack: ["webhookUrl"] }[channel];
  return Object.fromEntries(fields.map((field) => [field, text(value?.[field], field === "webhookUrl" ? 1_024 : 8_192)]));
}

export function notificationSummary({ type, title, message, timestamp = new Date().toISOString(), fileName, deviceCount, filledAddresses, rooms, processingTimeMs } = {}) {
  if (type !== "analysis") return null;
  const summary = { title: text(title || "Анализ завершён", 180), message: text(message || "Операция завершена.", 1_000), timestamp: text(timestamp, 40) };
  if (fileName) summary.fileName = text(fileName, 500);
  for (const [key, value] of Object.entries({ deviceCount, filledAddresses, rooms, processingTimeMs })) {
    if (value !== undefined && Number.isFinite(Number(value))) summary[key] = Number(value);
  }
  return summary;
}
