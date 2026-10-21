import test from "node:test";
import assert from "node:assert/strict";
import {
  appendLocalNotification,
  DEFAULT_LOCAL_NOTIFICATION_SETTINGS,
  LOCAL_NOTIFICATION_LIMIT,
  normalizeLocalNotificationLog,
  normalizeLocalNotificationSettings,
} from "../src/core/local-notifications.js";

test("local notification preferences default to the three supported event classes", () => {
  assert.deepEqual(normalizeLocalNotificationSettings(null), DEFAULT_LOCAL_NOTIFICATION_SETTINGS);
  assert.deepEqual(normalizeLocalNotificationSettings({
    events: { analysis: false, quality: "yes", other: true },
    email: { enabled: true, target: "external@example.com" },
  }), { events: { analysis: false, quality: true, backup: true } });
});

test("disabled event classes do not append a local notification", () => {
  const settings = { events: { analysis: false, quality: true, backup: true } };
  const result = appendLocalNotification([], { type: "analysis", title: "Analysis", message: "Done" }, settings, {
    id: "blocked", now: new Date("2026-10-21T12:00:00.000Z"),
  });
  assert.deepEqual(result, { log: [], added: null });
});

test("local journal is bounded, strips controls, escapes via text consumers, and has no channel fields", () => {
  const old = Array.from({ length: LOCAL_NOTIFICATION_LIMIT }, (_, index) => ({
    id: `old-${index}`, createdAt: "2026-10-20T12:00:00.000Z", type: "analysis", title: "Old", message: "Done", level: "info",
  }));
  const result = appendLocalNotification(old, {
    type: "quality", title: " Quality\u0000 report ", message: "Devices: 4\u0007; <local>", level: "success", channels: ["email"], secret: "discard",
  }, DEFAULT_LOCAL_NOTIFICATION_SETTINGS, { id: "new", now: new Date("2026-10-21T12:00:00.000Z") });
  assert.equal(result.log.length, LOCAL_NOTIFICATION_LIMIT);
  assert.equal(result.log[0].id, "new");
  assert.equal(result.log[0].title, "Quality report");
  assert.equal(result.log[0].message, "Devices: 4; <local>");
  assert.equal(result.log[0].status, "local");
  assert.equal("channels" in result.log[0], false);
  assert.equal("secret" in result.log[0], false);
  assert.equal(normalizeLocalNotificationLog(result.log).length, LOCAL_NOTIFICATION_LIMIT);
});

test("test records remain local and can be added with every event preference disabled", () => {
  const result = appendLocalNotification([], { type: "test", title: "Test", message: "Journal only" }, {
    events: { analysis: false, quality: false, backup: false },
  }, { id: "test", now: new Date("2026-10-21T12:00:00.000Z") });
  assert.deepEqual(result.added, {
    id: "test", createdAt: "2026-10-21T12:00:00.000Z", type: "test", title: "Test", message: "Journal only", level: "info", status: "local",
  });
});

test("malformed and external-channel records are discarded when loading the local journal", () => {
  const result = normalizeLocalNotificationLog([
    { id: "good", createdAt: "2026-10-21T12:00:00.000Z", type: "backup", title: "Backup", message: "Created" },
    { id: "external", createdAt: "2026-10-21T12:00:00.000Z", type: "smtp", title: "Mail", message: "Sent", channels: ["email"] },
    { id: "invalid", createdAt: "not-a-date", type: "analysis", title: "Bad", message: "Date" },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, "good");
  assert.equal(result[0].status, "local");
});
