# AI Manual

Voice-driven manual for Ableton Move and Schwung. Hold a bottom-row pad to ask a question, release to send — the tool transcribes your voice, asks Gemini or OpenAI, and displays a short headline answer with a scrollable detailed explanation below. Replies are grounded in Ableton's official Move manual and the Schwung user manual, both bundled with the Schwung host.

Installs under **Tools** in the Schwung menu.

## Requirements

- Schwung host with the voice-tool host bindings (`host_http_request_background`, `host_sampler_set_source`, `host_sampler_set_silent`, `host_read_file_base64`). Minimum host version is declared in `module-catalog.json` on the Schwung main repo.
- A Gemini or OpenAI API key. Free Gemini keys at https://aistudio.google.com/.
- Wi-Fi connection.

## Setup

1. Install via **Tools → Module Store → AI Manual**.
2. Open `http://move.local:7700/config` and scroll to **Assistant**. Pick a provider and paste your key. The key is stored on-device in a root-owned secrets directory.
3. Launch **Tools → AI Manual**.
4. Hold any pad in the bottom row, speak your question, release to send.

## Controls

| Input | Action |
|---|---|
| Bottom-row pad (hold) | Record question |
| Jog wheel / Knob 1 | Scroll long replies |
| Top-right pad | Clear conversation history |
| Back | Exit to Tools menu |

## Privacy

Audio is recorded locally, sent to the chosen provider for transcription + answer, then deleted from disk when the reply is received. API keys never leave the device except over TLS to the chosen provider.

## Building locally

```bash
./scripts/build.sh
# -> dist/ai-manual-module.tar.gz
```

## Releasing

1. Bump `version` in `src/module.json`
2. Commit and tag: `git tag v0.2.1 && git push origin main --tags`
3. GitHub Actions builds the tarball, cuts a release, and updates `release.json` on main
