#!/usr/bin/env node

import fs from "fs/promises";
import fetch from "node-fetch";
import { exec } from "child_process";

/* =====================================================
   CONFIG
   ===================================================== */

const LICENSE_PATH = "/app/license.lic";

const LICENSE_API_BASE =
  "https://f3tigq2rmb74psnp6nafqqg54i0kysrw.lambda-url.ap-south-1.on.aws/backend_api";

const ZABBIX_CONTAINER = "zabbix-server";
const ZABBIX_URL = "http://zabbix-web:8080";
const ZABBIX_USER = "Admin";
const ZABBIX_PASSWORD = "zabbix";

const CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const STARTUP_DELAY_MS = 60 * 1000;       // 1 minute
const RETRIES = 5;
const RETRY_DELAY = 15000;

/* =====================================================
   HELPERS
   ===================================================== */

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* =====================================================
   DOCKER CONTROL
   ===================================================== */

function docker(cmd) {
  return new Promise(resolve => {
    exec(cmd, (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout.trim());
    });
  });
}

async function controlZabbix(shouldRun) {
  const running = await docker(
    `docker ps --filter "name=${ZABBIX_CONTAINER}" --filter "status=running" --format "{{.Names}}"`
  );

  if (shouldRun && running === ZABBIX_CONTAINER) return;
  if (!shouldRun && running !== ZABBIX_CONTAINER) return;

  console.log(`🛑 Zabbix ${shouldRun ? "starting" : "stopping"}...`);
  await docker(`docker ${shouldRun ? "start" : "stop"} ${ZABBIX_CONTAINER}`);
}

/* =====================================================
   ZABBIX API (SAFE)
   ===================================================== */

async function fetchZabbixData() {
  for (let i = 1; i <= RETRIES; i++) {
    try {
      console.log(`🔄 Fetching Zabbix data (attempt ${i}/${RETRIES})`);

      // LOGIN
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

      const loginText = await loginRes.text();
      const login = JSON.parse(loginText);
      if (login.error) throw new Error("Login failed");

      const token = login.result;

      // VERSION
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

      const version = JSON.parse(await versionRes.text());

      // HOST COUNT
      const hostsRes = await fetch(`${ZABBIX_URL}/api_jsonrpc.php`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "host.get",
          params: { output: ["hostid"] },
          id: 3
        })
      });

      const hosts = JSON.parse(await hostsRes.text());
      if (hosts.error) throw new Error("host.get failed");

      return {
        zabbixVersion: version.result,
        totalHosts: hosts.result.length
      };

    } catch (err) {
      console.warn(`⚠️ Zabbix not ready: ${err.message}`);
      if (i < RETRIES) await sleep(RETRY_DELAY);
    }
  }

  return {
    zabbixVersion: "unknown",
    totalHosts: 0
  };
}

/* =====================================================
   LICENSE CHECK (FIXED)
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

  // 🔒 CRITICAL FIX
  if (!content) {
    console.error("❌ license.lic is empty");
    await controlZabbix(false);
    return null;
  }

  const [licenseKey, instanceId] = content.split("\n");

  if (!licenseKey || !instanceId) {
    console.error("❌ license.lic format invalid");
    await controlZabbix(false);
    return null;
  }

  let res, text, data;

  try {
    res = await fetch(`${LICENSE_API_BASE}/check-license/${licenseKey}`);
    text = await res.text();
    data = JSON.parse(text);
  } catch (err) {
    console.error("❌ License API error or non-JSON response");
    await controlZabbix(false);
    return null;
  }

  if (!res.ok || !data.valid) {
    console.error("❌ License invalid or expired");
    await controlZabbix(false);
    return null;
  }

  await controlZabbix(true);

  return {
    licenseKey,
    instanceId,
    expiry: data.expiryDate
  };
}

/* =====================================================
   MAIN LOOP
   ===================================================== */

(async function main() {
  console.log("🚀 License agent started (10-minute check interval)");
  await sleep(STARTUP_DELAY_MS);

  while (true) {
    const lic = await checkLicense();
    if (!lic) {
      console.error("❌ License check failed. Agent exiting.");
      process.exit(1);
    }

    const usage = await fetchZabbixData();

    console.log(`✅ Zabbix Version: ${usage.zabbixVersion}`);
    console.log(`✅ Total Hosts: ${usage.totalHosts}`);

    try {
      await fetch(`${LICENSE_API_BASE}/usage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...lic, ...usage })
      });
      console.log("✅ Usage data pushed");
    } catch {
      console.warn("⚠️ Failed to push usage data");
    }

    await sleep(CHECK_INTERVAL_MS);
  }
})();
