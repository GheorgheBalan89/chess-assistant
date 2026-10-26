# Chess Assistant

A Chess Assistant PWA. All chess logic and the Stockfish engine run client-side in
the browser — the Node/Express server only serves the static assets in `public/`.

## Prerequisites

- [Node.js](https://nodejs.org/) (includes npm)

## Setup

Install dependencies:

```bash
npm install
```

## Running the project

Start the server:

```bash
node server.js
```

You should see output similar to:

```
Chess Assistant running at http://localhost:3000
On your iPhone (same Wi-Fi), open http://<this-computer-ip>:3000
```

Then open [http://localhost:3000](http://localhost:3000) in your browser.

### Accessing from your phone

The server listens on `0.0.0.0`, so other devices on the same Wi-Fi network can
connect too. On your phone, open `http://<this-computer-ip>:3000`, replacing
`<this-computer-ip>` with your computer's local IP address (e.g. `192.168.1.42`).

### Changing the port

By default the server runs on port `3000`. Override it with the `PORT`
environment variable:

```bash
# PowerShell
$env:PORT=8080; node server.js

# bash/zsh
PORT=8080 node server.js
```
