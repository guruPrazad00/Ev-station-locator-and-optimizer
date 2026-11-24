"use strict";

// Bearer-token auth middleware. Attaches req.user = { id, role } or rejects.

const { verifyToken } = require("../services/auth");

function authRequired(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ error: "Authentication required. Send Authorization: Bearer <token>." });
  }
  try {
    const payload = verifyToken(token);
    req.user = { id: payload.sub, role: payload.role };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token. Please log in again." });
  }
}

function roleRequired(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: `This action requires the '${role}' role.` });
    }
    next();
  };
}

module.exports = { authRequired, roleRequired };
