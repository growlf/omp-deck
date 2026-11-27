import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

function readManagedEnvPort(): string | undefined {
	try {
		const xdg = process.env.XDG_CONFIG_HOME;
		const configDir = xdg ? path.resolve(xdg) : path.join(os.homedir(), '.config');
		const envPath = path.join(configDir, 'omp-deck', '.env');
		const content = fs.readFileSync(envPath, 'utf8');
		const match = content.match(/^OMP_DECK_PORT=(.+)$/m);
		return match ? match[1]!.trim() : undefined;
	} catch {
		return undefined;
	}
}

const SERVER_PORT = process.env.OMP_DECK_PORT ?? readManagedEnvPort() ?? "8788";
const SERVER_HOST = process.env.OMP_DECK_HOST ?? "0.0.0.0";
const WEB_PORT = Number(process.env.OMP_DECK_WEB_PORT ?? "5173");

const SERVER_HTTP = `http://${SERVER_HOST}:${SERVER_PORT}`;
const SERVER_WS = `ws://${SERVER_HOST}:${SERVER_PORT}`;

// ─── HTTPS / SSL Configuration ────────────────────────────────────────────────
// File System Access API requires a secure context (HTTPS or localhost).
// Generate a self-signed CA + cert for dev:
//   openssl genrsa -out ssl/ca-key.pem 4096
//   openssl req -new -x509 -days 3650 -key ssl/ca-key.pem -out ssl/ca.pem -subj "/CN=omp-deck-dev-CA"
//   openssl genrsa -out ssl/server-key.pem 2048
//   openssl req -new -key ssl/server-key.pem -out ssl/server.csr -subj "/CN=localhost"
//   openssl x509 -req -in ssl/server.csr -CA ssl/ca.pem -CAkey ssl/ca-key.pem \
//     -CAcreateserial -out ssl/server.pem -days 3650 \
//     -extfile <(printf "subjectAltName=DNS:localhost,DNS:*.localhost,IP:127.0.0.1,IP:0.0.0.0")
// Install the CA:  sudo cp ssl/ca.pem /usr/local/share/ca-certificates/omp-deck-dev-ca.crt && sudo update-ca-certificates
// ───────────────────────────────────────────────────────────────────────────────

const sslDir = path.resolve(__dirname, "ssl");
let serverHttps: unknown = false;
try {
	const caPath = path.join(sslDir, "ca.pem");
	const certPath = path.join(sslDir, "server.pem");
	const keyPath = path.join(sslDir, "server-key.pem");
	if (fs.existsSync(caPath) && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
		serverHttps = {
			ca: fs.readFileSync(caPath),
			key: fs.readFileSync(keyPath),
			cert: fs.readFileSync(certPath),
		};
	}
} catch {
	// No SSL certs — fall back to HTTP (localhost only)
}

const HTTPS_ENABLED = serverHttps !== false;
const DEV_URL = HTTPS_ENABLED
	? `https://${SERVER_HOST}:${WEB_PORT}`
	: `http://${SERVER_HOST}:${WEB_PORT}`;

export default defineConfig({
	plugins: [react()],
	envPrefix: ["VITE_", "OMP_DECK_"],
	define: {
		__DEV_URL__: JSON.stringify(DEV_URL),
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
	server: {
		host: SERVER_HOST,
		port: WEB_PORT,
		https: serverHttps as any,
		proxy: {
			"/api": { target: SERVER_HTTP, changeOrigin: true },
			"/ws": { target: SERVER_WS, ws: true, changeOrigin: true },
		},
	},
	build: {
		outDir: "dist",
		sourcemap: true,
	},
});
