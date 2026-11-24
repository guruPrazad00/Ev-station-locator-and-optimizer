"use strict";

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const app = require("./app");

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`VoltRoute backend listening on http://localhost:${PORT}`);
});
