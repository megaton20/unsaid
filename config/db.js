
const { Client } = require('pg');

const client = new Client({
  connectionString: process.env.NEON_KEY,
  // ssl: {
  //   rejectUnauthorized: false,
  // },
});

client.connect()
  .then(() => console.log("Connected to Neon DB"))
  .catch(err => console.error("DB connection error:", err));

module.exports = client;
