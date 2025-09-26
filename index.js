import express from 'express';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import fetch from 'node-fetch';
import pkg from '@signalwire/node';
import bodyParser from 'body-parser';
import { createServer } from 'http';
import { URL } from 'url';

const { VoiceResponse } = pkg;

// Load environment variables
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SIGNALWIRE_PROJECT_ID = process.env.SIGNALWIRE_PROJECT_ID;
const SIGNALWIRE_API_TOKEN = process.env.SIGNALWIRE_API_TOKEN;
const SIGNALWIRE_SPACE_URL = process.env.SIGNALWIRE_SPACE_URL;

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

// Store active OpenAI connections
const openAIConnections = new Map();

// Logging function
function log(message, data = '') {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`, data ? JSON.stringify(data, null, 2) : '');
}

// POST /voice endpoint - Returns SignalWire XML to connect to WebSocket
app.post('/voice', (req, res) => {
  log('Received SignalWire voice request');
  
  const response = new VoiceResponse();
  
  // Create WebSocket URL for this call
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host;
  const wsUrl = `${protocol === 'https' ? 'wss' : 'ws'}://${host}/signalwire-media`;
  
  log(`Connecting to WebSocket: ${wsUrl}`);
  
  // Connect to WebSocket media stream
  const connect = response.connect();
  connect.stream({ url: wsUrl });
  
  res.type('text/xml');
  res.send(response.toString());
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    activeConnections: openAIConnections.size
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
