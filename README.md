# openzo

A self-hosted Zo Computer: your own AI agent with a real shell, a persistent workspace, a terminal and scheduled automations, for one person or a whole team, on your laptop or a VPS.

Built from the open parts of Zo's stack — [eve](https://github.com/vercel/eve) (the agent framework Zo's agent layer runs on) and [@zocomputer/agent-sdk](https://github.com/zocomputer/agent-sdk) (Zo's tool library) — plus a control plane written for openzo: accounts and invites, one isolated runtime per user (gVisor containers on a VPS), files, terminal, automations, admin.

```bash
./start-local.sh                                          # local, http://127.0.0.1:8080
OPENZO_DOMAIN=zo.example.com sudo -E bash deploy/install.sh   # VPS, multi-user, gVisor, HTTPS
bash tools/check.sh                                       # the gate
```

No key needed to start: new accounts use a free keyless model lane; switch to OpenAI, Anthropic, OpenRouter, Groq, Ollama or any OpenAI-compatible server in Settings.

**Read [docs/GUIDE.md](docs/GUIDE.md)** for usage, hosting, configuration, the security model and what is stubbed.

Licences: eve is Apache-2.0, @zocomputer/agent-sdk is MIT. openzo is not affiliated with Zo Computer.
