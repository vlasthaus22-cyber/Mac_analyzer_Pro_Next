import test from "node:test";
import assert from "node:assert/strict";
import { normalizeNotificationSettings, normalizeNotificationSecret, notificationSummary } from "../src/core/notification-settings.js";

test("notification channels default off and responses never hydrate secrets", () => {
  const settings = normalizeNotificationSettings({ channels: { telegram: { enabled: true, chatId: "chat" } }, secretsConfigured: { telegram: true }, token: "must-not-copy" });
  assert.equal(settings.channels.email.enabled, false);
  assert.equal(settings.channels.telegram.enabled, true);
  assert.equal(settings.secretsConfigured.telegram, true);
  assert.equal("token" in settings, false);
  assert.deepEqual(normalizeNotificationSecret("telegram", { botToken: "abc", webhookUrl: "not-for-telegram" }), { botToken: "abc" });
});

test("analysis summaries are bounded, include only aggregate counts, omit device-address fields, and exclude non-analysis events", () => {
  assert.equal(notificationSummary({ type: "backup", title: "Archive" }), null);
  const summary = notificationSummary({ type: "analysis", title: "Done\nignored", message: "7 devices", deviceCount: 7, filledAddresses: 5, rooms: 3, processingTimeMs: 1200, fileName: "source.xlsx", ip: "10.0.0.1" });
  assert.equal(summary.title, "Doneignored");
  assert.equal(summary.deviceCount, 7);
  assert.equal(summary.fileName, "source.xlsx");
  assert.equal(summary.filledAddresses, 5);
  assert.equal(summary.rooms, 3);
  assert.equal(summary.processingTimeMs, 1200);
  assert.equal("ip" in summary, false);
});
