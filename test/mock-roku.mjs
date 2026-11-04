// A stateful fake Roku TV speaking ECP on 127.0.0.1:8060, built from real (scrubbed) responses.
import http from "node:http";
import { readFileSync } from "node:fs";

const fixture = (name) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");
const DEVICE_INFO = fixture("device-info.xml");
const APPS = fixture("apps.xml");
const AUDIO_DEVICE = fixture("audio-device.xml");
const HOME = { id: "562859", type: "home", name: "Roku Dynamic Menu" };

// Endpoints a real TV still answers in "limited" mode (verified against a TCL 32S301, Roku OS 15.3.4).
const LIMITED_ALLOWED = new Set(["/", "/query/device-info", "/query/active-app"]);

export function startMockRoku({ port = 8060 } = {}) {
  const state = {
    mode: "enabled",
    powerMode: "PowerOn",
    active: HOME,
    down: false,
    shutdownMs: 0,
    ignorePowerOnUntil: 0,
    requests: [],
  };

  const apps = [...APPS.matchAll(/<app id="([^"]+)" type="([^"]+)"[^>]*>([^<]*)<\/app>/g)].map(
    ([, id, type, name]) => ({ id, type, name }),
  );

  const server = http.createServer((req, res) => {
    if (state.down) return req.socket.destroy(); // simulates a TV that dropped off the network
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    state.requests.push(`${req.method} ${path}`);
    const send = (status, body, type = "text/xml") => {
      res.writeHead(status, { "content-type": type });
      res.end(body);
    };

    if (state.mode === "limited" && !LIMITED_ALLOWED.has(path)) {
      return send(403, "ECP command not allowed in Limited mode.", "text/plain");
    }

    if (req.method === "GET" && path === "/query/device-info") {
      return send(
        200,
        DEVICE_INFO.replace(/<ecp-setting-mode>[^<]*</, `<ecp-setting-mode>${state.mode}<`).replace(
          /<power-mode>[^<]*</,
          `<power-mode>${state.powerMode}<`,
        ),
      );
    }
    if (req.method === "GET" && path === "/query/apps") return send(200, APPS);
    if (req.method === "GET" && path === "/query/audio-device") return send(200, AUDIO_DEVICE);
    if (req.method === "GET" && path === "/query/active-app") {
      const a = state.active;
      // Real TV in Limited mode: the home screen is reported in full, anything else is redacted.
      if (state.mode === "limited" && a !== HOME) {
        return send(200, `<?xml version="1.0" encoding="UTF-8" ?>\n<active-app>\n\t<app>Roku</app>\n</active-app>\n`);
      }
      return send(200, `<?xml version="1.0" encoding="UTF-8" ?>\n<active-app>\n\t<app id="${a.id}" type="${a.type}" version="1.0.0">${a.name}</app>\n</active-app>\n`);
    }
    if (req.method === "POST" && path.startsWith("/launch/")) {
      const app = apps.find((a) => a.id === path.slice("/launch/".length));
      if (!app) return send(404, "");
      state.active = app;
      return send(200, "");
    }
    if (req.method === "POST" && path.startsWith("/keypress/")) {
      const key = path.slice("/keypress/".length);
      if (key === "Home") state.active = HOME;
      else if (key === "PowerOff") {
        state.powerMode = "Ready";
        // Like the real TV: PowerOn is accepted but ignored while it is still shutting down.
        state.ignorePowerOnUntil = Date.now() + state.shutdownMs;
      } else if (key === "PowerOn" && Date.now() >= state.ignorePowerOnUntil) state.powerMode = "PowerOn";
      return send(200, "");
    }
    send(404, "");
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ state, close: () => new Promise((r) => server.close(r)) }));
  });
}
