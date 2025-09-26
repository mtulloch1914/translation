import express from 'express';
import bodyParser from 'body-parser';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';

// Load environment variables
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SIGNALWIRE_PROJECT_ID = process.env.SIGNALWIRE_PROJECT_ID;
const SIGNALWIRE_API_TOKEN = process.env.SIGNALWIRE_API_TOKEN;

// Validate required environment variables
if (!OPENAI_API_KEY || !SIGNALWIRE_PROJECT_ID || !SIGNALWIRE_API_TOKEN) {
  console.error('Missing required environment variables:');
  console.error('Required: OPENAI_API_KEY, SIGNALWIRE_PROJECT_ID, SIGNALWIRE_API_TOKEN');
  process.exit(1);
}

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Logging function
function log(message, data = '') {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`, data ? JSON.stringify(data, null, 2) : '');
}

// POST /voice endpoint - Returns simple XML
app.post('/voice', (req, res) => {
  log('Received SignalWire voice request');
  
  // Simple XML response without VoiceResponse
  const xmlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/signalwire-media"/>
  </Connect>
</Response>`;
  
  log(`Connecting to WebSocket: wss://${req.headers.host}/signalwire-media`);
  
  res.type('text/xml');
  res.send(xmlResponse);
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    activeConnections: 0
  });
});

// Start server
server.listen(PORT, () => {
  log(`Server running on port ${PORT}`);
  log('Environment variables loaded:');
  log(`- OPENAI_API_KEY: ${OPENAI_API_KEY ? '✓' : '✗'}`);
  log(`- SIGNALWIRE_PROJECT_ID: ${SIGNALWIRE_PROJECT_ID ? '✓' : '✗'}`);
  log(`- SIGNALWIRE_API_TOKEN: ${SIGNALWIRE_API_TOKEN ? '✓' : '✗'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    log('Server closed');
    process.exit(0);
  });
});
