# ovrc-tcl-roku

An [OvrC Integration](https://snap-one.github.io/ovrc-integration) for TCL Roku TVs.
It lets OvrC monitor and control the TV over Roku's local [External Control Protocol (ECP)](https://developer.roku.com/docs/developer-program/dev-tools/external-control-api.md): plain HTTP on port 8060, no cloud account or credentials.

This is a personal learning project built on an early draft of the OvrC integration framework.
It is not an official Snap One, Roku, or TCL product.

## What it supports

| Display method | Supported | How (Roku ECP) |
|---|---|---|
| `getSystem` | Yes | `GET /query/device-info`: brand, model, serial, device name, language, country |
| `getFirmware` | Read only | Roku OS version and build. Roku updates itself; there is no update control. |
| `getNetwork` | Read only | Wi-Fi/Ethernet MAC, SSID, active interface |
| `getPower` / `setPowerState` | Yes | `power-mode`; `PowerOn` / `PowerOff` keypresses |
| `getInputs` / `setInputsActive` | Yes | HDMI, AV and tuner inputs (with the labels you set on the TV); `POST /launch/tvinput.*` |
| `getAppSources` / `setAppSourcesActive` | Yes | Installed apps; `POST /launch/{appId}` |
| `dispatchAppSourcesTerminate` | Yes | Returns to Home (Roku has no "close app" command) |
| `getActiveContexts` | Yes | `GET /query/active-app`, plus the active audio output |
| `getOutputs` | Read only | Undocumented `GET /query/audio-device`: volume, mute, active destination (TV speakers, optical, ARC, headphones, ...) |
| `getVideo` | Not reported | ECP exposes no picture settings; answers all-`null` so OvrC doesn't flag an error |
| `getAuthentication` / `setAuthentication` | Yes | Reports whether the TV allows network control (see below) |
| `getMetadata` | Partial | Links to the TV maker's support site |

Not possible over ECP: reboot, firmware updates, picture/video settings, changing the audio destination, audio format, CEC/ARC, renaming inputs, network configuration.
The Display spec has no volume or mute setters, so volume is read-only even though the TV accepts `VolumeUp`/`VolumeDown`/`VolumeMute` keypresses.
Those methods return JSON-RPC `-32601` (method not found).

## Enable network control

Recent Roku OS versions ship with network control set to **Limited**.
In that mode the TV still reports its device info, power state and current app, but it refuses input, app and power commands.
OvrC shows the device as needing authentication until this is changed.

On the TV: **Settings > System > Advanced system settings > Control by mobile apps > Network access**, then choose **Enabled** (or **Permissive**).

## Device matching

The manifest matches a device that:

- answers SSDP with `ST: roku:ecp`, and
- describes itself over UPnP as `urn:roku-com:device:player:1-0` with a `manufacturerURL` on `support.tcl.com`.

Other Roku TV brands use the same protocol and would work with a different `manufacturerURL` matcher.

## Development

Requirements:

- Node.js 24 (see `.node-version`; the scaffolding tools need Node >= 22.12).
- The OvrC integration CLI from the [snap-one/ovrc-integration releases](https://github.com/snap-one/ovrc-integration/releases), on your `PATH` as `ovrc`.
  Note: an older, unrelated `ovrc-cli` npm package also installs an `ovrc` command.
  `ovrc integration --help` should list `serve` and `test`.

```bash
npm install
npm test                        # typecheck, build, run end-to-end tests against a mock TV
ROKU_IP=192.168.1.50 npm test   # run the read-only tests against a real TV
ovrc integration serve ./dist   # open OvrC in Integration Developer Mode
```

Set `OVRC_BIN=/path/to/ovrc` if another `ovrc` command shadows the integration CLI.

### Tests

`test/integration.test.mjs` starts `ovrc integration test` and calls the integration over JSON-RPC, the same way OvrC does.
`test/mock-roku.mjs` is a stateful fake TV built from real ECP responses (identifiers scrubbed), including Limited-mode `403` behavior.

## License

[MIT](LICENSE)
