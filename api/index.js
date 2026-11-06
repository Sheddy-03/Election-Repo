'use strict';
// Vercel serverless entry point: every /api/* request is routed here (see vercel.json).
const { handler } = require('../src/server');
module.exports = handler;
module.exports.config = { maxDuration: 30 };
