"use strict";

// Vercel serverless entry point for the VoltRoute Express app.
// The Express app is exported as a serverless function handler so Vercel can
// route every HTTP request through it (API + static frontend).

const app = require("../backend/app.js");

// Export the Express app as the Vercel serverless handler.
module.exports = app;
