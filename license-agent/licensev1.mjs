#!/usr/bin/env node

import fs from "fs/promises";
import fetch from "node-fetch";
import { exec } from "child_process";

// === CONFIGURATION ===
const LICENSE_PATH = "/app/license.lic";
const LICENSE_API_URL =
  "https://f3tigq2rmb74psnp6nafqqg54i0kysrw.lambda-url.ap-south-1.on.aws/backend_api/check-license";
const ZABBIX_CONTAINER = "zabbix-server";
const ZABBIX_URL = "http://zabbix-web:8080";
const ZABBIX_USER = "Admin";
const ZABBIX_PASSWORD = "zabbix";
const CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

// === HELPERS ===
function controlZabbix(shouldRun) {
  return new Promise((resolve) => {
    exec(
      `docker ps --filter "name=${ZABBIX_CONTAINER}" --filter "status=running" --format "{{.Names}}"`,
      (err, stdout) => {
        const isRunning = stdout.trim() === ZABBIX_CONTAINER;
        if ((shouldRun && isRunning) || (!shouldRun && !isRunning)) {
          console.log(
            `ℹ️  Zabbix container already ${shouldRun ? "running" : "stopped"}.`
          );
          return resolve();
        }

        const cmd = shouldRun
          ? `docker start ${ZABBIX_CONTAINER}`
          : `docker stop ${ZABBIX_CONTAINER}`;
        exec(cmd, (err2, stdout2, stderr2) => {
          if (err2) {
            console.error(`❌ Error running "${cmd}":`, stderr2 || err2.message);
          } else {
            console.log(`✅ Zabbix container ${shouldRun ? "started" : "stopped"}.`);
          }
          resolve();
        });
      }
    );
  });
}

async function fetchZabbixData() {
  try {
    // 1) Login to Zabbix -> auth token
    const loginRes = await fetch(`${ZABBIX_URL}/api_jsonrpc.php`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "user.login",
        params: { username: ZABBIX_USER, password: ZABBIX_PASSWORD },
        id: 1,
      }),
    });

    const loginJson = await loginRes.json();
    if (!loginRes.ok || loginJson.error) {
      console.error("❌ Zabbix login error:", loginJson.error || loginRes.statusText);
      return { zabbixVersion: "unknown", totalHosts: 0 };
    }
    const authToken = loginJson.result;

    // 2) Get Zabbix version
    const versionRes = await fetch(`${ZABBIX_URL}/api_jsonrpc.php`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "apiinfo.version",
        params: {},
        id: 2,
      }),
    });
    const versionJson = await versionRes.json();
    const zabbixVersion = versionJson.result || "unknown";

    // 3) Get hosts count
    const hostsRes = await fetch(`${ZABBIX_URL}/api_jsonrpc.php`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "host.get",
        params: { output: ["hostid", "host"] },
        id: 3,
      }),
    });

    const hostsJson = await hostsRes.json();
    if (hostsJson.error) {
      console.error("❌ host.get API error:", hostsJson.error);
      return { zabbixVersion, totalHosts: 0 };
    }
    const hosts = Array.isArray(hostsJson.result) ? hostsJson.result : [];
    return { zabbixVersion, totalHosts: hosts.length };
  } catch (err) {
    console.error("❌ Failed to fetch Zabbix data:", err.message || err);
    return { zabbixVersion: "unknown", totalHosts: 0 };
  }
}

// === LICENSE CHECK & PUSH USAGE ===
async function checkLicenseAndUpdate() {
  try {
    const licenseFile = (await fs.readFile(LICENSE_PATH, "utf-8")).trim().split("\n");
    const licenseKey = licenseFile[0]?.trim();
    const instanceId = licenseFile[1]?.trim();

    if (!licenseKey || !instanceId) {
      console.error("❌ License file invalid or missing");
      await controlZabbix(false);
      return false;
    }

    console.log("🔍 Checking license:", licenseKey);
    const res = await fetch(`${LICENSE_API_URL}/${licenseKey}`);
    const body = await res.json();

    if (!res.ok || !body.valid) {
      console.error("❌ License invalid or expired:", body?.message || "unknown");
      await controlZabbix(false);
      return false;
    }

    console.log(`✅ License valid | Expiry: ${body.expiryDate} | Client: ${body.clientId}`);
    await controlZabbix(true);

    // Fetch Zabbix data
    const { zabbixVersion, totalHosts } = await fetchZabbixData();
    console.log(`✅ Zabbix Version: ${zabbixVersion}`);
    console.log(`✅ Total Hosts: ${totalHosts}`);

    // Push usage data
    try {
      await fetch(`${LICENSE_API_URL}/usage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ licenseKey, instanceId, zabbixVersion, totalHosts }),
      });
      console.log("✅ Usage data pushed to license API.");
    } catch (pushErr) {
      console.error("⚠️ Failed to push usage data:", pushErr.message || pushErr);
    }

    return true;
  } catch (error) {
    console.error("❌ Script error:", error.message || error);
    await controlZabbix(false);
    return false;
  }
}

// === MAIN LOOP ===
(async function main() {
  console.log("🚀 License agent started (10-minute check interval)");

  // Initial check
  const initialValid = await checkLicenseAndUpdate();
  if (!initialValid) {
    console.error("⛔ Startup license check failed");
    process.exit(1);
  }

  // Periodic checks
  while (true) {
    await new Promise((r) => setTimeout(r, CHECK_INTERVAL_MS));
    const valid = await checkLicenseAndUpdate();
    if (!valid) {
      console.error("⛔ License became invalid — stopping service");
      process.exit(1);
    }
  }
})();

