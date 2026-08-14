// Vercel serverless function entry point.
// Vercel auto-detects this file and routes ALL requests (that aren't matched by a
// static file) through it. The Express app is shared with server.js so local and
// production run identical code. When a Vercel KV store is linked to the project,
// lib/store.js automatically persists state to KV (durable across function invocations).
module.exports = require('../server');
