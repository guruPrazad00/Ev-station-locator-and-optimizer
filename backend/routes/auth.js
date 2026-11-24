"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");
const { getPool, toPublicUser } = require("../db");
const { hashPassword, verifyPassword, signToken } = require("../services/auth");
const { authRequired } = require("../middleware/auth");

const router = express.Router();

// Stricter abuse protection for credential endpoints.
const authLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
router.use(authLimiter);

function validEmail(value) {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
}

// POST /api/auth/register { name, email, password, role: user|owner }
router.post("/register", async (req, res, next) => {
  try {
    const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 80) : "";
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase().slice(0, 120) : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const role = req.body?.role === "owner" ? "owner" : "user";
    if (!name) return res.status(400).json({ error: "Name is required." });
    if (!validEmail(email)) return res.status(400).json({ error: "A valid email address is required." });
    if (password.length < 8 || password.length > 128) {
      return res.status(400).json({ error: "Password must be 8–128 characters." });
    }
    const db = getPool();
    const [existing] = await db.query("SELECT id FROM users WHERE email = ?", [email]);
    if (existing.length) return res.status(409).json({ error: "An account with this email already exists." });
    const passwordHash = await hashPassword(password);
    const [result] = await db.query(
      "INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)",
      [name, email, passwordHash, role]
    );
    const [rows] = await db.query("SELECT * FROM users WHERE id = ?", [result.insertId]);
    const user = toPublicUser(rows[0]);
    res.status(201).json({ user, token: signToken(user) });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/login { email, password }
router.post("/login", async (req, res, next) => {
  try {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!email || !password) return res.status(400).json({ error: "Email and password are required." });
    const db = getPool();
    const [found] = await db.query("SELECT * FROM users WHERE email = ?", [email]);
    const row = found[0];
    // Same response whether the email exists or not (no account enumeration).
    if (!row || !(await verifyPassword(password, row.password_hash))) {
      return res.status(401).json({ error: "Invalid email or password." });
    }
    const user = toPublicUser(row);
    res.json({ user, token: signToken(user) });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me (Bearer token)
router.get("/me", authRequired, async (req, res, next) => {
  try {
    const [found] = await getPool().query("SELECT * FROM users WHERE id = ?", [req.user.id]);
    const row = found[0];
    if (!row) return res.status(401).json({ error: "Account no longer exists." });
    res.json(toPublicUser(row));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
