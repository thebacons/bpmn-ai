# AI BPMN Panel (bpmn-js example)

This example adds an AI-assisted panel to a bpmn-js modeler. It generates BPMN 2.0 XML from natural-language prompts and loads the result directly into the canvas. The UI includes prompt helpers, validation rules, and a local AI API server to avoid CORS and keep credentials on your machine.

## Features

- Prompt to BPMN 2.0 XML generation
- Validation for missing swimlanes, BPMN DI, and dangling flows
- Auto-fix loop for common issues
- Local AI server with OpenAI, Claude, Gemini, or Ollama support
- Custom palette + context pad from the custom elements demo

## Quick Start

This example depends on the local bpmn-js sources in this repo. Build the distro once so the assets are available.

```sh
# from the repo root
npm install
npm run distro

# run the example
cd examples/ai-bpmn-panel
npm install
npm start
```

The modeler runs at `http://localhost:5000` and the AI server runs at `http://localhost:5174`.

## How It Works

1. The UI collects your prompt, model, and AI settings.
2. A local Node server (`server.js`) calls the selected AI provider.
3. The server returns BPMN 2.0 XML only.
4. The app validates the XML and optionally auto-fixes common issues.
5. The diagram is imported into the canvas automatically.

## Credentials

Set one of the following environment variables (or paste a credential in the UI):

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`
- `GEMINI_API_KEY`
- `OLLAMA_URL` (optional, defaults to `http://localhost:11434`)
- `AI_PORT` (optional, defaults to `5174`)

For Ollama, ensure you have local models installed (for example: `ollama pull llama3.1`).

## License

See `LICENSE` in the repo root.
