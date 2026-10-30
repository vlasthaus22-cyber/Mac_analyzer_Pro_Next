import test from "node:test";
import assert from "node:assert/strict";
import { deliverAnalysisNotification, notificationApiBase, saveNotificationChannel, testNotificationChannel } from "../src/ui/notification-controls.js";

test("notification control accepts only explicit same-computer HTTP host", () => {
  assert.equal(notificationApiBase({ protocol: "http:", hostname: "127.0.0.1", port: "4000", origin: "http://127.0.0.1:4000" }), "http://127.0.0.1:4000");
  assert.equal(notificationApiBase({ protocol: "https:", hostname: "127.0.0.1", port: "4000" }), null);
  assert.equal(notificationApiBase({ protocol: "http:", hostname: "example.test", port: "4000" }), null);
});

test("notification settings and sends use same-origin requests without redirect following", async () => {
  const calls = [];
  const options = { locationLike: { protocol: "http:", hostname: "localhost", port: "4001", origin: "http://localhost:4001" }, fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ settings: { enabled: true, chatId: "c" }, secretsConfigured: true, channels: {} }) }; } };
  await saveNotificationChannel("telegram", { enabled: true, chatId: "c" }, { botToken: "secret" }, options);
  await testNotificationChannel("telegram", options);
  await deliverAnalysisNotification({ type: "analysis", title: "Done", message: "2 devices" }, options);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(JSON.parse(calls[0].init.body).secret.botToken, "secret");
  assert.equal(JSON.parse(calls[1].init.body).channel, "telegram");
  assert.equal(JSON.parse(calls[2].init.body).type, "analysis");
});
