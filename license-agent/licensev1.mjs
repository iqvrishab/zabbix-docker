#!/usr/bin/env node

import fs from "fs/promises";
import fetch from "node-fetch";
import { exec } from "child_process";

/* =====================================================
   CONFIG
   ===================================================== */

const LICENSE_PATH = "/app/license.lic";

/**
 * ⚠️ IMPORTANT
 * This MUST match the VM script
 * VM uses: /backend_api/check-license/usage
 */
const LICENSE_API_BASE =
  "https://f3tigq2rmb74psnp6nafqqg54i0kysrw.lambda-url.ap-south-1.on.aws/backend_api/check-license";

const ZABBIX_CONTAINER = "zabbix-server";

// Zabbix runs inside Docker network
const ZABBIX_URL = "http://zabbix-web:8080";
const ZABBIX_USER = "Admin";
const ZABBIX_PASSWORD = "zabbix";

const CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const STARTUP_DELAY_MS = 60 * 1000;       // 1 minute

/* =====================================================
   HELPERS
   ===================================================== */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function docker(cmd) {
  return new Promise((resolve) => {
    exec(cmd, (_, stdout) => resolve(stdout?.trim() || null));
  });
}

/* =====================================================
   DOCKER CONTROL
   ===================================================== */

async function controlZabbix(shouldRun) {
  const running = await docker(
    `docker ps --filter "name=${ZABBIX_CONTAINER}" --filter "status=running" --format "{{.Names}}"`
  );

  if (shouldRun && running === ZABBIX_CONTAINER) return;
  if (!shouldRun && running !== ZABBIX_CONTAINER) return;

  await docker(`docker ${shouldRun ? "start" : "stop"} ${ZABBIX_CONTAINER}`);
}

/* =====================================================
   ZABBIX DATA (VM LOGIC – STABLE)
   ===================================================== */

async function fetchZabbixData() {
  try {
    // 1) Login
    const loginRes = await fetch(`${ZABBIX_URL}/api_jsonrpc.php`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "user.login",
        params: { username: ZABBIX_USER, password: ZABBIX_PASSWORD },
        id: 1
      })
    });

    const loginJson = await loginRes.json();
    if (loginJson.error) {
      console.error("❌ Zabbix login failed:", loginJson.error);
      return { zabbixVersion: "unknown", totalHosts: 0 };
    }

    const authToken = loginJson.result;

    // 2) Version (no auth needed in Zabbix 7)
    const versionRes = await fetch(`${ZABBIX_URL}/api_jsonrpc.php`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "apiinfo.version",
        params: {},
        id: 2
      })
    });

    const versionJson = await versionRes.json();
    const zabbixVersion = versionJson.result || "unknown";

    // 3) Host count (Bearer token for Zabbix 7)
    const hostsRes = await fetch(`${ZABBIX_URL}/api_jsonrpc.php`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "host.get",
        params: { output: ["hostid"] },
        id: 3
      })
    });

    const hostsJson = await hostsRes.json();
    const hosts = Array.isArray(hostsJson.result) ? hostsJson.result : [];

    return {
      zabbixVersion,
      totalHosts: hosts.length
    };

  } catch (err) {
    console.error("❌ Failed to fetch Zabbix data:", err.message || err);
    return { zabbixVersion: "unknown", totalHosts: 0 };
  }
}

/* =====================================================
   LICENSE CHECK
   ===================================================== */

async function checkLicense() {
  let content;

  try {
    content = (await fs.readFile(LICENSE_PATH, "utf-8")).trim();
  } catch {
    console.error("❌ license.lic not found");
    await controlZabbix(false);
    return null;
  }

  const [licenseKey, instanceId] = content.split("\n");

  if (!licenseKey || !instanceId) {
    console.error("❌ license.lic invalid");
    await controlZabbix(false);
    return null;
  }

  const res = await fetch(`${LICENSE_API_BASE}/${licenseKey}`);
  const data = await res.json();

  if (!res.ok || !data.valid) {
    console.error("❌ License invalid or expired");
    await controlZabbix(false);
    return null;
  }

  await controlZabbix(true);

  return { licenseKey, instanceId };
}

/* =====================================================
   MAIN LOOP
   ===================================================== */

(async function main() {
  console.log("🚀 License agent started (Docker / VM logic)");
  await sleep(STARTUP_DELAY_MS);

  while (true) {
    const lic = await checkLicense();
    if (!lic) process.exit(1);

    const usage = await fetchZabbixData();

    console.log(`✅ Zabbix Version: ${usage.zabbixVersion}`);
    console.log(`✅ Total Hosts: ${usage.totalHosts}`);

    // 🔥 THIS IS THE CRITICAL FIX 🔥
    const res = await fetch(`${LICENSE_API_BASE}/usage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        licenseKey: lic.licenseKey,
        instanceId: lic.instanceId,
        zabbixVersion: usage.zabbixVersion,
        totalHosts: usage.totalHosts
      })
    });

    if (!res.ok) {
      console.error("❌ Failed to push usage data:", res.status);
    } else {
      console.log("✅ Usage data pushed");
    }

    await sleep(CHECK_INTERVAL_MS);
  }
})();
