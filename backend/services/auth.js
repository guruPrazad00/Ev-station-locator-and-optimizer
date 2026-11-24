"use strict";

// Password hashing (bcrypt) + JWT issuance/verification.
// JWT_SECRET must be set in production; a dev-only fallback keeps local
// prototype runs working and loudly warns about itself.

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "";
const JWT_EXPIRES = process.env.JWT_EXPIRES || "7d";
const BCRYPT_ROUNDS = 12;

if (!JWT_SECRET) {
  console.warn("[auth] WARNING: JWT_SECRET is not set — using an insecure dev-only secret. Set JWT_SECRET in .env.");
}

const SECRET = JWT_SECRET || "voltroute-dev-only-secret-do-not-use-in-production";

// A real bcrypt hash of an unguessable value. Login compares against it when
// the email is unknown so the reply takes roughly the same time either way,
// preventing account enumeration via response-timing differences.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync("voltroute-not-a-real-password", BCRYPT_ROUNDS);

function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, SECRET, { expiresIn: JWT_EXPIRES });
}

function verifyToken(token) {
  return jwt.verify(token, SECRET);
}

function publicUser(row) {
  if (!row) return null;
  return { id: row.id, name: row.name, email: row.email, role: row.role, createdAt: row.created_at };
}

module.exports = { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword, signToken, verifyToken, publicUser };
