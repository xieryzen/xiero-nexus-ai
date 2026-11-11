// Entry point of a Xiero Nexus AI release bundle:  node start.js
//
// scripts/package-release.sh copies this file into the bundle as start.js.
// It prepares the environment, checks the things that most often go wrong on a
// fresh server, and then hands over to the Next.js standalone server.
"use strict";

const fs = require("fs");
const path = require("path");

function fail(lines) {
  console.error(["", "[xiero-nexus] Cannot start.", "", ...lines, ""].join("\n"));
  process.exit(1);
}

// 1. This bundle carries a native SQLite module, so it only runs on the
//    platform and Node.js major version it was built for.
const built = {};
try {
  for (const line of fs.readFileSync(path.join(__dirname, "VERSION"), "utf8").split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) built[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
} catch {
  // No VERSION file (for example when run from a source checkout): skip the check.
}
const nodeMajor = process.versions.node.split(".")[0];
const platform = `${process.platform}-${process.arch}`;
if (built.node && built.node !== nodeMajor) {
  fail([
    `This bundle was built for Node.js ${built.node}, but this server runs Node.js ${process.version}.`,
    `Either switch the server to Node.js ${built.node}, or download the bundle whose name ends in`,
    `"node${nodeMajor}.zip" from the same release.`,
  ]);
}
if (built.platform && built.platform !== platform) {
  fail([
    `This bundle was built for ${built.platform}, but this server is ${platform}.`,
    "Build a bundle on this machine instead: see RELEASING.md, \"Other platforms\".",
  ]);
}

// 2. Settings: real environment variables always win over the .env file.
const portFromEnvironment = process.env.PORT;
const envFile = path.join(__dirname, ".env");
if (fs.existsSync(envFile)) {
  if (typeof process.loadEnvFile === "function") {
    try {
      process.loadEnvFile(envFile);
    } catch (err) {
      console.warn(`[xiero-nexus] Could not read ${envFile}: ${err.message}`);
    }
  } else {
    console.warn(
      `[xiero-nexus] Node.js ${process.version} cannot read .env files (20.12 or newer can). ` +
        "Set the variables in the environment instead.",
    );
  }
}

// 3. Port: PORT from the environment, else the port a hosting panel assigned
//    (Pterodactyl sets SERVER_PORT), else PORT from .env, else 3000.
process.env.PORT = portFromEnvironment || process.env.SERVER_PORT || process.env.PORT || "3000";
// Containers set HOSTNAME to the container id, which the server would otherwise
// try to bind to. Bind all interfaces unless BIND_HOST says otherwise.
process.env.HOSTNAME = process.env.BIND_HOST || "0.0.0.0";

// 4. The encryption key is required. Stop now, with instructions, rather than
//    failing later when a provider key has to be stored.
if (Buffer.from(process.env.SECRET_ENCRYPTION_KEY || "", "base64").length !== 32) {
  fail([
    "SECRET_ENCRYPTION_KEY is missing, or is not 32 bytes in base64.",
    "",
    `Create ${envFile} (copy .env.example) and set the key. Generate one with:`,
    "",
    "  node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    "",
    "Keep the key safe and keep it when you upgrade: stored provider API keys and",
    "2FA secrets cannot be read without it.",
  ]);
}

require("./server.js");
