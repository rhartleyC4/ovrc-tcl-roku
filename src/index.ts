import {
  serveRpc,
  type ActiveContext,
  type AppSource,
  type Authentication,
  type Input,
  type KeyValuePair,
  type NetworkInterface,
  type Output,
  type OutputAudio,
  type PowerPowerState,
  type methodDispatchAppSourcesTerminate,
  type methodGetActiveContexts,
  type methodGetAppSources,
  type methodGetAuthentication,
  type methodGetFirmware,
  type methodGetInputs,
  type methodGetMetadata,
  type methodGetNetwork,
  type methodGetOutputs,
  type methodGetVideo,
  type methodGetPower,
  type methodGetSystem,
  type methodSetAppSourcesActive,
  type methodSetAuthentication,
  type methodSetInputsActive,
  type methodSetPowerState,
} from "@snap-one/ovrc-integration-display";
import { getDevice } from "ovrc:core";
import { deviceFetch } from "ovrc:net";
import { RpcError } from "ovrc:rpc";

// --- Roku External Control Protocol (ECP): plain HTTP on port 8060 -------

const ECP_PORT = 8060;
const SETUP_URL = "https://github.com/rhartleyC4/ovrc-tcl-roku#enable-network-control";

// JSON-RPC server-defined error range (-32000..-32099).
const ERR_CONTROL_DISABLED = -32001;
const ERR_DEVICE = -32002;
const ERR_UNREACHABLE = -32003;
const ERR_BAD_ARGS = -32602;

async function ecp(path: string, method: "GET" | "POST" = "GET"): Promise<string> {
  const ip = getDevice().ipv4;
  let res: Response;
  try {
    res = await deviceFetch(`http://${ip}:${ECP_PORT}${path}`, { method });
  } catch (e) {
    throw new RpcError(
      `Could not reach the TV at ${ip}:${ECP_PORT} (${e instanceof Error ? e.message : e}). ` +
        `Check it is powered and that Settings > System > Power > Fast TV Start is on.`,
      ERR_UNREACHABLE,
    );
  }
  const body = await res.text();
  if (res.status === 403) {
    throw new RpcError(
      `The TV blocked ${path}: "Control by mobile apps" is limited or disabled. See ${SETUP_URL}`,
      ERR_CONTROL_DISABLED,
    );
  }
  if (!res.ok) throw new RpcError(`Roku ECP ${method} ${path} returned HTTP ${res.status}`, ERR_DEVICE);
  return body;
}

const keypress = (key: string) => ecp(`/keypress/${key}`, "POST");
const launch = (id: string) => ecp(`/launch/${encodeURIComponent(id)}`, "POST");

// ponytail: regex XML parsing. ECP responses are flat and stable; no XML parser exists in the runtime.
const unescapeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function tag(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`));
  return m?.[1] ? unescapeXml(m[1].trim()) : null;
}

type RokuApp = { id: string; type: string; name: string };

function parseApps(xml: string): RokuApp[] {
  return [...xml.matchAll(/<app\s+id="([^"]+)"\s+type="([^"]+)"[^>]*>([^<]*)<\/app>/g)].map(
    ([, id, type, name]) => ({ id: id!, type: type!, name: unescapeXml(name!.trim()) }),
  );
}

// device-info backs most getters; fetch it at most once per invocation.
function deviceInfo() {
  let cached: Promise<string> | undefined;
  return (field: string) => (cached ??= ecp("/query/device-info")).then((xml) => tag(xml, field));
}

// --- Mapping helpers --------------------------------------------------------

// Roku power-mode values: PowerOn, DisplayOff, Ready, Headless, Suspend.
const toPowerState = (mode: string | null): "ON" | "STANDBY" | "UNKNOWN" =>
  mode === "PowerOn" ? "ON" : mode ? "STANDBY" : "UNKNOWN";

function powerState(current: "ON" | "STANDBY" | "UNKNOWN"): PowerPowerState {
  // ponytail: spec is ambiguous; "allowed" = the state you can switch to from here.
  return { current, allowedPowerState: current === "ON" ? "STANDBY" : "ON" };
}

// ponytail: Roku OS UI languages; unknown codes fall back to the raw code.
const LANGUAGES: Record<string, string> = { en: "English", es: "Spanish", fr: "French", de: "German", pt: "Portuguese", it: "Italian" };

const INPUT_NAMES: Record<string, string> = { cvbs: "AV", dtv: "Live TV", tuner: "Live TV" };

function inputFriendlyName(id: string): string {
  const port = id.replace(/^tvinput\./, "");
  const hdmi = port.match(/^hdmi(\d+)$/);
  return hdmi ? `HDMI ${hdmi[1]}` : (INPUT_NAMES[port] ?? port.toUpperCase());
}

function toInput(app: RokuApp): Input {
  const port = app.id.replace(/^tvinput\./, "");
  const kind = port.startsWith("hdmi") ? "HDMI" : port === "cvbs" ? "COMPOSITE" : "TUNER";
  return {
    id: app.id,
    friendlyName: inputFriendlyName(app.id),
    label: { canSet: false, label: app.name },
    canActivate: true,
    connectionType: { key: kind, friendlyName: kind === "COMPOSITE" ? "Composite" : kind === "TUNER" ? "Tuner" : "HDMI", canonicalId: null },
    connectionTypes: null,
    connectionPresent: "UNKNOWN", // ECP does not report cable or signal presence
    signalPresent: "UNKNOWN",
    cecMode: null,
    cecModes: null,
    arcMode: null,
    arcModes: null,
  };
}

const toAppSource = (app: RokuApp): AppSource => ({
  id: app.id,
  friendlyName: app.name,
  canActivate: true,
  canTerminate: true,
  canonicalId: null,
});

const CONTEXT_ID = "main"; // Roku TVs have no picture-in-picture: one context

async function activeContext(): Promise<ActiveContext> {
  const [app] = parseApps(await ecp("/query/active-app"));
  const ctx: ActiveContext = { id: CONTEXT_ID, canReportInput: true, canReportSource: true, input: null, source: null, outputs: null };
  if (!app) return ctx;
  if (app.type === "tvin") ctx.input = toInput(app);
  else ctx.source = toAppSource(app.type === "home" ? { ...app, id: "home", name: "Home" } : app);
  return ctx;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(() => r(), ms));

// After a launch/keypress the TV takes a moment to switch; poll until it reports the target.
async function settle(isDone: (ctx: ActiveContext) => boolean): Promise<ActiveContext> {
  let ctx = await activeContext();
  for (let i = 0; i < 10 && !isDone(ctx); i++) {
    await sleep(300);
    ctx = await activeContext();
  }
  return ctx;
}

function requireContext(contextId: string) {
  if (contextId !== CONTEXT_ID) throw new RpcError(`Unknown context "${contextId}"`, ERR_BAD_ARGS);
}

async function apps(type: "tvin" | "appl"): Promise<RokuApp[]> {
  return parseApps(await ecp("/query/apps")).filter((a) => a.type === type);
}

// --- Handlers ----------------------------------------------------------------

async function authentication(): Promise<Authentication> {
  let mode: string | null;
  try {
    mode = await deviceInfo()("ecp-setting-mode");
  } catch (e) {
    if (e instanceof RpcError && e.code === ERR_CONTROL_DISABLED) mode = "disabled";
    else throw e;
  }
  return {
    id: "network-control",
    label: 'Enable "Control by mobile apps" on the TV',
    // Older Roku OS builds omit ecp-setting-mode and allow full control.
    valid: mode !== "limited" && mode !== "disabled",
    documentationURL: SETUP_URL,
    fields: [],
  };
}

const getAuthentication: methodGetAuthentication = async () => ({
  methods: async () => [await authentication()],
});

// Nothing to submit; re-checks the TV setting so "Save" in OvrC refreshes the status.
const setAuthentication: methodSetAuthentication = async () => authentication();

const getSystem: methodGetSystem = async () => {
  const info = deviceInfo();
  return {
    brand: () => info("vendor-name"),
    model: () => info("model-name"),
    serialNumber: () => info("serial-number"),
    friendlyName: () => info("friendly-device-name"),
    label: async () => ({ canSet: false, label: (await info("user-device-name")) ?? "" }),
    language: async () => {
      const lang = await info("language");
      return lang
        ? { active: { key: lang, friendlyName: LANGUAGES[lang] ?? lang, canonicalId: null }, available: null, availableSource: null }
        : null;
    },
    country: async () => {
      const country = await info("country");
      return country ? { active: { key: country, friendlyName: country, canonicalId: null }, available: null, availableSource: null } : null;
    },
    contactInformation: null,
  };
};

const getFirmware: methodGetFirmware = async () => {
  const info = deviceInfo();
  return {
    version: async () => {
      const [version, build, buildNumber] = await Promise.all([
        info("software-version"),
        info("software-build"),
        info("build-number"),
      ]);
      if (!version) return null;
      return {
        current: { id: buildNumber ?? version, friendlyName: `Roku OS ${version} (build ${build ?? "?"})` },
        updateCandidates: null, // Roku updates itself; ECP exposes no update control
      };
    },
    status: { updateStatus: "UNSUPPORTED" },
  };
};

const getMetadata: methodGetMetadata = async () => {
  const info = deviceInfo();
  return {
    knowledgeBaseURL: async () => {
      const url = await info("support-url");
      return url ? (url.startsWith("http") ? url : `https://${url}`) : null;
    },
    userManualURL: null,
    dataAcquisition: null,
  };
};

const getNetwork: methodGetNetwork = async () => {
  const info = deviceInfo();
  return {
    interfaces: async () => {
      const [type, wifiMac, ethMac, ssid, hasEthernet] = await Promise.all([
        info("network-type"),
        info("wifi-mac"),
        info("ethernet-mac"),
        info("network-name"),
        info("supports-ethernet"),
      ]);
      const ipv4 = { canSet: false, addressType: null, effective: { address: getDevice().ipv4 } };
      const mac = (m: string | null) => m?.toUpperCase() ?? null; // OvrC shows MACs in upper case
      const ifaces: NetworkInterface[] = [
        {
          id: "wifi",
          friendlyName: "Wi-Fi",
          adapterType: "WIRELESS",
          enabled: type === "wifi",
          canEnable: false,
          macAddress: mac(wifiMac),
          wifi: { ssid: type === "wifi" ? ssid : null },
          ipv4: type === "wifi" ? ipv4 : null,
        },
      ];
      if (hasEthernet === "true") {
        ifaces.push({
          id: "ethernet",
          friendlyName: "Ethernet",
          adapterType: "WIRED",
          enabled: type === "ethernet",
          canEnable: false,
          macAddress: mac(ethMac),
          wifi: null,
          ipv4: type === "ethernet" ? ipv4 : null,
        });
      }
      return ifaces;
    },
  };
};

const getPower: methodGetPower = async () => {
  const info = deviceInfo();
  return {
    state: async () => powerState(toPowerState(await info("power-mode"))),
    canReboot: null, // ECP has no reboot command
    powerSavingMode: null,
    wakeOnLAN: null, // device-info only says it is supported, not whether it is on
  };
};

// A TCL Roku TV accepts PowerOn (HTTP 200) but ignores it for several seconds after turning off,
// while reporting power-mode "Ready" the whole time. So: re-send until the TV confirms, and
// report the state it actually reached, never the one requested.
const POWER_TIMEOUT_MS = 10_000;
const POWER_RESEND_MS = 2_500;

const setPowerState: methodSetPowerState = async ({ args }) => {
  const want = args.state === "ON" ? "ON" : "STANDBY";
  const key = want === "ON" ? "PowerOn" : "PowerOff";
  const start = Date.now();
  let lastSent = 0;
  let current: "ON" | "STANDBY" | "UNKNOWN" = "UNKNOWN";
  while (Date.now() - start < POWER_TIMEOUT_MS) {
    if (Date.now() - lastSent >= POWER_RESEND_MS) {
      await keypress(key);
      lastSent = Date.now();
    }
    await sleep(500);
    current = toPowerState(tag(await ecp("/query/device-info"), "power-mode"));
    if (current === want) break;
  }
  return powerState(current);
};

const getInputs: methodGetInputs = async () => ({
  available: async () => (await apps("tvin")).map(toInput),
  cecMode: null,
  arcMode: null,
});

const setInputsActive: methodSetInputsActive = async ({ args }) => {
  requireContext(args.contextId);
  if (!args.inputId.startsWith("tvinput.")) throw new RpcError(`Not an input: "${args.inputId}"`, ERR_BAD_ARGS);
  await launch(args.inputId);
  return settle((ctx) => ctx.input?.id === args.inputId);
};

const getAppSources: methodGetAppSources = async () => ({
  available: async () => (await apps("appl")).map(toAppSource),
  canTerminate: true,
});

const setAppSourcesActive: methodSetAppSourcesActive = async ({ args }) => {
  requireContext(args.contextId);
  if (args.sourceId === "home") await keypress("Home");
  else await launch(args.sourceId);
  return settle((ctx) => ctx.source?.id === args.sourceId);
};

// Roku has no "close app" command; going Home ends the app.
const dispatchAppSourcesTerminate: methodDispatchAppSourcesTerminate = async ({ args }) => {
  requireContext(args.contextId);
  await keypress("Home");
  return settle((ctx) => ctx.source?.id === "home");
};

const getActiveContexts: methodGetActiveContexts = async () => ({
  contexts: async () => {
    // audio-device is blocked in Limited mode; still report the active app/input.
    const [ctx, audio] = await Promise.all([activeContext(), audioDevice()().catch(() => null)]);
    return [{ ...ctx, outputs: audio ? mainOutputs(audio) : null }];
  },
});

// --- Audio: undocumented ECP /query/audio-device (Roku TVs, verified on Roku OS 15.3) ---

// Roku destination names -> OvrC KeyValuePairs. canonicalIds follow the spec's examples.
const DESTINATIONS: Record<string, { friendlyName: string; canonicalId: string | null }> = {
  speakers: { friendlyName: "TV Speakers", canonicalId: "CONN:INTERNAL" },
  spdif: { friendlyName: "Digital Optical", canonicalId: "CONN:OPTICAL" },
  arc: { friendlyName: "HDMI ARC", canonicalId: null },
  lineout: { friendlyName: "Line Out", canonicalId: null },
  headphones: { friendlyName: "Headphones", canonicalId: null },
  "peripheral-speakers": { friendlyName: "Roku Wireless Speakers", canonicalId: null },
  "mobile-sas": { friendlyName: "Private Listening (mobile app)", canonicalId: null },
  "wifi-remote-sas": { friendlyName: "Private Listening (remote)", canonicalId: null },
};

// Where the sound is primarily heard when several destinations are active at once
// (optical and line out are always "on" alongside the speakers).
const PRIMARY_ORDER = ["headphones", "mobile-sas", "wifi-remote-sas", "arc", "peripheral-speakers", "speakers"];

const toDestination = (name: string): KeyValuePair => ({ key: name, ...(DESTINATIONS[name] ?? { friendlyName: name, canonicalId: null }) });
const toAudio = (xml: string): OutputAudio => {
  const level = Number(tag(xml, "volume"));
  return {
    volume: Number.isFinite(level) ? { level, min: 0, max: 100, step: 1 } : null,
    muted: tag(xml, "muted") === null ? null : tag(xml, "muted") === "true",
    format: null, // not reported by the TV
  };
};

function audioDevice() {
  let cached: Promise<string> | undefined;
  return () => (cached ??= ecp("/query/audio-device"));
}

// The TV has a single audio output channel; its destination is where sound is heard.
function mainOutputs(xml: string): Output[] | null {
  const active = (tag(xml, "destination-list") ?? "").split(",").filter(Boolean);
  const all = (tag(xml, "all-destinations") ?? "").split(",").filter((d) => d in DESTINATIONS);
  const primary = PRIMARY_ORDER.find((d) => active.includes(d)) ?? active[0];
  if (!primary) return null;
  const perDestination = xml.match(new RegExp(`<destination name="${primary}">([\\s\\S]*?)</destination>`))?.[1];
  return [
    {
      id: "main",
      friendlyName: "TV Audio",
      destination: {
        active: toDestination(primary),
        available: all.map(toDestination),
        availableSource: "API",
        canSelectActive: null, // ECP cannot change the audio destination
        audio: perDestination ? toAudio(perDestination) : null,
      },
    },
  ];
}

const getOutputs: methodGetOutputs = async () => {
  const audio = audioDevice();
  return {
    allAudio: async () => {
      const global = (await audio()).match(/<global>([\s\S]*?)<\/global>/)?.[1];
      return global ? toAudio(global) : null;
    },
    available: async () => mainOutputs(await audio()),
  };
};

// ECP exposes no picture settings, so every field is "not reported".
// OvrC calls this on every page load and treats "method not found" as a device error.
const getVideo: methodGetVideo = async () => ({
  screenMute: null,
  aspectRatio: null,
  pictureMode: null,
  brightness: null,
  contrast: null,
  sharpness: null,
});

await serveRpc({
  getAuthentication,
  setAuthentication,
  getSystem,
  getFirmware,
  getMetadata,
  getNetwork,
  getPower,
  setPowerState,
  getInputs,
  setInputsActive,
  getAppSources,
  setAppSourcesActive,
  dispatchAppSourcesTerminate,
  getActiveContexts,
  getOutputs,
  getVideo,
});
