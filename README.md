# bpmn-js - BPMN 2.0 for the web

[![Build Status](https://github.com/bpmn-io/bpmn-js/workflows/CI/badge.svg)](https://github.com/bpmn-io/bpmn-js/actions?query=workflow%3ACI)

View and edit BPMN 2.0 diagrams in the browser.

[![bpmn-js screencast](./resources/screencast.gif "bpmn-js in action")](http://demo.bpmn.io/s/start)

## Installation

Use the library [pre-packaged](https://github.com/bpmn-io/bpmn-js-examples/tree/main/pre-packaged)
or include it [via npm](https://github.com/bpmn-io/bpmn-js-examples/tree/main/bundling)
into your node-style web-application.

## Usage

To get started, create a [bpmn-js](https://github.com/bpmn-io/bpmn-js) instance
and render [BPMN 2.0 diagrams](https://www.omg.org/spec/BPMN/2.0.2/) in the browser:

```javascript
const xml = '...'; // my BPMN 2.0 xml
const viewer = new BpmnJS({
  container: 'body'
});

try {
  const { warnings } = await viewer.importXML(xml);

  console.log('rendered');
} catch (err) {
  console.log('error rendering', err);
}
```

Checkout our [examples](https://github.com/bpmn-io/bpmn-js-examples) for many
more supported usage scenarios.

### Dynamic Attach/Detach

You may attach or detach the viewer dynamically to any element on the page, too:

```javascript
const viewer = new BpmnJS();

// attach it to some element
viewer.attachTo('#container');

// detach the panel
viewer.detach();
```

## Resources

* [Demo](http://demo.bpmn.io)
* [Issues](https://github.com/bpmn-io/bpmn-js/issues)
* [Examples](https://github.com/bpmn-io/bpmn-js-examples)
* [Forum](https://forum.bpmn.io)
* [Changelog](./CHANGELOG.md)

## Build and Run

Prepare the project by installing all dependencies:

```sh
npm install
```

Then, depending on your use-case you may run any of the following commands:

```sh
# build the library and run all tests
npm run all

# spin up a single local modeler instance
npm start

# run the full development setup
npm run dev
```

You may need to perform [additional project setup](./docs/project/SETUP.md) when
building the latest development snapshot.

## Examples

- `examples/ai-bpmn-panel`: AI-assisted BPMN panel with a local AI server. See the example README for setup and usage.

## AI BPMN Panel Example

To try the AI panel demo:

```sh
# from the repo root
npm install
npm run distro

cd examples/ai-bpmn-panel
npm install
npm start
```

The modeler runs at `http://localhost:5000` and the AI server runs at `http://localhost:5174`.

To integrate the panel into your own app, use the example as a template:

- UI: `examples/ai-bpmn-panel/app` (panel layout, prompt helpers, validation)
- Server: `examples/ai-bpmn-panel/server.js` (local AI proxy + model catalog)
- Config: set `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`, `GEMINI_API_KEY`, and optional `OLLAMA_URL` and `AI_PORT`

See `examples/ai-bpmn-panel/README.md` for detailed setup, prompts, and troubleshooting.

## Related

bpmn-js builds on top of a few powerful tools:

* [bpmn-moddle](https://github.com/bpmn-io/bpmn-moddle): Read / write support for BPMN 2.0 XML in the browsers
* [diagram-js](https://github.com/bpmn-io/diagram-js): Diagram rendering and editing toolkit

It is an extensible toolkit, complemented by many [additional utilities](https://github.com/bpmn-io/awesome-bpmn-io). 

## License

Use under the terms of the [bpmn.io license](http://bpmn.io/license).
