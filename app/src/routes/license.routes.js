const express = require("express");
const crypto = require("crypto");
const sqlite3 = require("sqlite3").verbose();

const router = express.Router();

const DB_PATH = "/opt/ff-news/data/licenses.db";
const SECRET = process.env.LICENSE_SECRET || "";

function nowEpoch() { return Math.floor(Date.now() / 1000); }

function tokenForHour(licenseId, account, server, hourBucket) {
  const payload = `${licenseId}|${account}|${server}|${hourBucket}`;
  const h = crypto.createHmac("sha256", SECRET).update(payload).digest();
  const num = h.readUInt32BE(0) % 100000000; // 8 dígitos
  return String(num).padStart(8, "0");
}

router.get("/check", (req, res) => {
  const licenseId = String(req.query.license_id || "").trim();
  const account = parseInt(String(req.query.account || ""), 10);
  const server = String(req.query.server || "").trim();

  if (!SECRET || SECRET.length < 16) {
    return res.status(500).json({ ok: false, error: "license_secret_not_set" });
  }
  if (!licenseId || licenseId.length < 6) {
    return res.status(400).json({ ok: false, error: "missing_license_id" });
  }
  if (!Number.isFinite(account) || account <= 0) {
    return res.status(400).json({ ok: false, error: "missing_account" });
  }
  if (!server) {
    return res.status(400).json({ ok: false, error: "missing_server" });
  }

  const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, (err) => {
    if (err) return res.status(500).json({ ok: false, error: "db_open_failed" });
  });

  db.get(
    "SELECT enabled, bind_account, bind_server FROM licenses WHERE license_id = ? LIMIT 1",
    [licenseId],
    (err, row) => {
      db.close();
      if (err) return res.status(500).json({ ok: false, error: "db_query_failed" });

      let allowed = !!(row && row.enabled === 1);
      if (allowed && row.bind_account !== account) allowed = false;
      if (allowed && row.bind_server !== server) allowed = false;

      const now = nowEpoch();
      const hourBucket = Math.floor(now / 3600);
      const token = allowed ? tokenForHour(licenseId, account, server, hourBucket) : "";
      const tokenValidUntil = (hourBucket + 1) * 3600;

      return res.json({
        ok: true,
        allowed,
        server_epoch: now,
        token,
        token_valid_until_epoch: tokenValidUntil,
        next_check_sec: 300
      });
    }
  );
});

module.exports = router;
