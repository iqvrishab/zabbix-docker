import express from "express";
import fs from "fs/promises";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import { createProxyMiddleware } from "http-proxy-middleware";

const LICENSE_PATH = "./license.lic";
const LICENSE_API_URL =
  "https://f3tigq2rmb74psnp6nafqqg54i0kysrw.lambda-url.ap-south-1.on.aws/backend_api/check-license";

const ZABBIX_URL = "http://zabbix-web:8080";

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// LICENSE MIDDLEWARE
app.use(async (req, res, next) => {
  try {
    const licenseFile = (await fs.readFile(LICENSE_PATH, "utf-8"))
      .trim()
      .split("\n");

    const licenseKey = licenseFile[0]?.trim();
    const instanceId = licenseFile[1]?.trim();

    if (!licenseKey || !instanceId) {
      return res.sendFile("custom.html", { root: __dirname });
    }

    const response = await fetch(`${LICENSE_API_URL}/${licenseKey}`);
    const body = await response.json();

    if (!body.valid) {
      return res.sendFile("custom.html", { root: __dirname });
    }

    next();
  } catch {
    return res.sendFile("custom.html", { root: __dirname });
  }
});

// PROXY TO ZABBIX
app.use(
  "/",
  createProxyMiddleware({
    target: ZABBIX_URL,
    changeOrigin: true,
    ws: true
  })
);

app.listen(3333, () => {
  console.log("✅ License proxy running on port 3333");
});

