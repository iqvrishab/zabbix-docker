import express from "express";
import fs from "fs/promises";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import { createProxyMiddleware } from "http-proxy-middleware";

const LICENSE_PATH = "/app/license.lic";
const LICENSE_API =
  "https://f3tigq2rmb74psnp6nafqqg54i0kysrw.lambda-url.ap-south-1.on.aws/backend_api/check-license";

const ZABBIX_URL = "http://zabbix-web:8080";

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* =====================================================
   STATIC FILES FOR LICENSE PAGE
   ===================================================== */
app.use("/static", express.static(path.join(__dirname, "static")));

/* =====================================================
   LICENSE GUARD (ABSOLUTE)
   ===================================================== */
app.use(async (req, res, next) => {
  try {
    // Read license
    const licenseText = await fs.readFile(LICENSE_PATH, "utf-8");
    const [licenseKey, instanceId] = licenseText.trim().split("\n");

    if (!licenseKey || !instanceId) {
      return res.status(403).sendFile("custom.html", { root: __dirname });
    }

    const r = await fetch(`${LICENSE_API}/${licenseKey}`);
    const contentType = r.headers.get("content-type") || "";
    const bodyText = await r.text();

    if (!contentType.includes("application/json")) {
      return res.status(403).sendFile("custom.html", { root: __dirname });
    }

    const data = JSON.parse(bodyText);

    if (!r.ok || !data.valid) {
      return res.status(403).sendFile("custom.html", { root: __dirname });
    }

    // ✅ License valid → allow proxy
    next();
  } catch (err) {
    return res.status(403).sendFile("custom.html", { root: __dirname });
  }
});

/* =====================================================
   PROXY TO ZABBIX (ONLY IF LICENSE VALID)
   ===================================================== */
app.use(
  "/",
  createProxyMiddleware({
    target: ZABBIX_URL,
    changeOrigin: true,
    ws: true,
    xfwd: true
  })
);

app.listen(3333, () => {
  console.log("✅ License proxy running on port 3333");
});
