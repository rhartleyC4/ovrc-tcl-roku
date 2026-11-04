// End-to-end: drives the built integration through `ovrc integration test` over JSON-RPC.
// Default: against the mock TV. With ROKU_IP=<ip>: read-only checks against a real TV.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMockRoku } from "./mock-roku.mjs";

const REAL_IP = process.env.ROKU_IP;
const mockOnly = { skip: REAL_IP ? "changes TV state or needs the mock" : false };

let mock, server, url;

before(async () => {
  if (!REAL_IP) mock = await startMockRoku();
  const storage = join(mkdtempSync(join(tmpdir(), "ovrc-roku-")), "store.db");
  server = spawn(process.env.OVRC_BIN ?? "ovrc", [
    "integration", "test", "./dist",
    "--device-ip", REAL_IP ?? "127.0.0.1",
    "--port", "0",
    "--storage", storage,
  ]);
  url = await new Promise((resolve, reject) => {
    let out = "";
    const onData = (d) => {
      out += d;
      const m = out.match(/listening at (http:\/\/\S+)/);
      if (m) resolve(m[1]);
    };
    server.stdout.on("data", onData);
    server.stderr.on("data", onData);
    server.once("exit", (code) => reject(new Error(`ovrc exited (${code}):\n${out}`)));
    setTimeout(() => reject(new Error(`ovrc did not start:\n${out}`)), 15000).unref();
  });
});

after(async () => {
  server?.kill();
  await mock?.close();
});

async function rpc(method, includeFields = [], args = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "1", method, params: { args, includeFields } }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const [reply] = await res.json();
  return reply;
}

async function result(method, includeFields, args) {
  const reply = await rpc(method, includeFields, args);
  assert.equal(reply.error, undefined, JSON.stringify(reply.error));
  return reply.result;
}

test("getSystem reports brand, model and serial", async () => {
  const r = await result("getSystem", ["brand", "model", "serialNumber", "label", "language"]);
  assert.equal(r.brand, "TCL");
  assert.match(r.model, /\S/);
  assert.match(r.serialNumber, /^[A-Z0-9]{12}$/);
  assert.equal(r.label.canSet, false);
  assert.equal(r.language.active.key, "en");
  assert.equal(r.language.active.friendlyName, "English");
});

test("unrequested lazy fields are not computed", async () => {
  const r = await result("getSystem", ["brand"]);
  assert.equal(r.brand, "TCL");
  // The runtime always echoes plain (non-function) values such as contactInformation: null.
  for (const lazy of ["model", "serialNumber", "label", "language", "country"]) assert.ok(!(lazy in r), lazy);
});

test("getFirmware reports the Roku OS version", async () => {
  const r = await result("getFirmware", ["version", "status"]);
  assert.match(r.version.current.friendlyName, /^Roku OS \d+\.\d+/);
  assert.equal(r.status.updateStatus, "UNSUPPORTED");
});

test("getNetwork reports the Wi-Fi interface", async () => {
  const { interfaces } = await result("getNetwork", ["interfaces"]);
  const wifi = interfaces.find((i) => i.id === "wifi");
  assert.equal(wifi.adapterType, "WIRELESS");
  assert.match(wifi.macAddress, /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/); // upper case, like the rest of OvrC
});

test("getPower maps power-mode", async () => {
  const { state } = await result("getPower", ["state", "canReboot"]);
  assert.ok(["ON", "STANDBY"].includes(state.current));
});

test("getInputs lists physical inputs with their on-TV labels", async () => {
  const { available } = await result("getInputs", ["available"]);
  const hdmi1 = available.find((i) => i.id === "tvinput.hdmi1");
  assert.equal(hdmi1.friendlyName, "HDMI 1");
  assert.match(hdmi1.label.label, /\S/);
  assert.ok(available.every((i) => i.id.startsWith("tvinput.")));
});

test("getAppSources lists installed apps and decodes XML entities", async () => {
  const { available } = await result("getAppSources", ["available"]);
  assert.ok(available.length > 0);
  assert.ok(available.every((a) => !a.id.startsWith("tvinput.")));
  if (!REAL_IP) assert.ok(available.some((a) => a.friendlyName === "Plex - Free Movies & TV"));
});

test("getActiveContexts reports one context", async () => {
  const { contexts } = await result("getActiveContexts", ["contexts"]);
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].id, "main");
  assert.equal(contexts[0].outputs[0].id, "main"); // feeds OvrC's "Audio Output" field
  assert.match(contexts[0].outputs[0].destination.active.friendlyName, /\S/);
});

test("getAuthentication is valid when network control is enabled", async () => {
  const { methods } = await result("getAuthentication", ["methods"]);
  assert.equal(methods[0].valid, true);
});

test("setInputsActive switches input and reports it", mockOnly, async () => {
  const r = await result("setInputsActive", ["input", "source"], { contextId: "main", inputId: "tvinput.hdmi2" });
  assert.equal(r.input.id, "tvinput.hdmi2");
  assert.equal(r.source, null);
  assert.deepEqual(mock.state.requests.filter((q) => q.startsWith("POST")).at(-1), "POST /launch/tvinput.hdmi2");
});

test("setAppSourcesActive launches an app; terminate returns Home", mockOnly, async () => {
  const launched = await result("setAppSourcesActive", ["source"], { contextId: "main", sourceId: "12" });
  assert.equal(launched.source.friendlyName, "Netflix");
  const home = await result("dispatchAppSourcesTerminate", ["source"], { contextId: "main", sourceId: "12" });
  assert.equal(home.source.id, "home");
});

test("setInputsActive rejects non-input ids and unknown contexts", mockOnly, async () => {
  assert.equal((await rpc("setInputsActive", ["input"], { contextId: "main", inputId: "12" })).error.code, -32602);
  assert.equal((await rpc("setInputsActive", ["input"], { contextId: "pip", inputId: "tvinput.hdmi1" })).error.code, -32602);
});

test("setPowerState sends PowerOff / PowerOn", mockOnly, async () => {
  assert.equal((await result("setPowerState", ["current"], { state: "STANDBY" })).current, "STANDBY");
  assert.equal(mock.state.powerMode, "Ready");
  assert.equal((await result("setPowerState", ["current"], { state: "ON" })).current, "ON");
  assert.equal(mock.state.powerMode, "PowerOn");
});

test("setPowerState re-sends PowerOn the TV ignored while shutting down", mockOnly, async () => {
  mock.state.shutdownMs = 3000; // real TV: PowerOn ~3s after PowerOff was ignored
  try {
    await result("setPowerState", ["current"], { state: "STANDBY" });
    const sent = mock.state.requests.length;
    assert.equal((await result("setPowerState", ["current"], { state: "ON" })).current, "ON");
    const presses = mock.state.requests.slice(sent).filter((q) => q === "POST /keypress/PowerOn").length;
    assert.ok(presses >= 2, `expected a re-sent PowerOn, saw ${presses}`);
  } finally {
    mock.state.shutdownMs = 0;
  }
});

test("limited mode: auth turns invalid and blocked calls explain why", mockOnly, async () => {
  mock.state.mode = "limited";
  try {
    const { methods } = await result("getAuthentication", ["methods"]);
    assert.equal(methods[0].valid, false);
    assert.match(methods[0].documentationURL, /enable-network-control/);

    const blocked = await rpc("getInputs", ["available"]);
    assert.equal(blocked.error.code, -32001);
    assert.match(blocked.error.message, /Control by mobile apps/);

    // device-info and active-app still work in limited mode
    assert.equal((await result("getSystem", ["brand"])).brand, "TCL");
    const { contexts } = await result("getActiveContexts", ["contexts"]);
    assert.equal(contexts[0].outputs, null);
  } finally {
    mock.state.mode = "enabled";
  }
});

test("getOutputs reports volume, mute and the active audio destination", async () => {
  const { allAudio, available } = await result("getOutputs", ["available", "allAudio"]);
  assert.ok(Number.isInteger(allAudio.volume.level));
  assert.equal(allAudio.volume.max, 100);
  assert.equal(typeof allAudio.muted, "boolean");
  const [main] = available;
  assert.equal(main.id, "main");
  assert.match(main.destination.active.friendlyName, /\S/);
  assert.ok(main.destination.available.some((d) => d.canonicalId === "CONN:OPTICAL"));
  assert.equal(main.destination.canSelectActive, null);
  if (!REAL_IP) {
    assert.equal(allAudio.volume.level, 18);
    assert.deepEqual(main.destination.active, { key: "speakers", friendlyName: "TV Speakers", canonicalId: "CONN:INTERNAL" });
  }
});

test("getVideo answers 'not reported' instead of erroring", async () => {
  // OvrC calls it on every device page load and treats errors as device problems.
  const video = await result("getVideo", ["pictureMode", "aspectRatio"]);
  assert.equal(video.pictureMode, null);
  assert.equal(video.aspectRatio, null);
});

test("an unreachable TV yields a clear error, not an uncaught TypeError", mockOnly, async () => {
  mock.state.down = true;
  try {
    const { error } = await rpc("getSystem", ["brand"]);
    assert.equal(error.code, -32003);
    assert.match(error.message, /Could not reach the TV at 127\.0\.0\.1:8060/);
  } finally {
    mock.state.down = false;
  }
});

test("unsupported methods return method-not-found", async () => {
  assert.equal((await rpc("dispatchPowerReboot")).error.code, -32601);
});
