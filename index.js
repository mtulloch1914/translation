import express from 'express';
import bodyParser from 'body-parser';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';

// Load environment variables
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Validate required environment variables
if (!OPENAI_API_KEY) {
  console.error('Missing required environment variables:');
  console.error('Required: OPENAI_API_KEY');
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

// POST /voice endpoint - Returns SignalWire XML
app.post('/voice', (req, res) => {
  log('Received SignalWire voice request');
  
  const xmlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/signalwire-media"/>
  </Connect>
</Response>`;
  
  res.type('text/xml');
  res.send(xmlResponse);
});

// WebSocket endpoint for SignalWire Media Stream
wss.on('connection', (ws, req) => {
  if (req.url !== '/signalwire-media') {
    ws.close();
    return;
  }
  
  log('SignalWire WebSocket connected');
  
  // Send welcome message
  ws.send(JSON.stringify({
    event: 'media',
    streamSid: 'test-stream',
    media: {
      payload: Buffer.from('Hello! Connected to translator.').toString('base64')
    }
  }));
  
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      log(`Received: ${message.event}`);
      
      if (message.event === 'start') {
        log('Stream started', { streamSid: message.start.streamSid });
      } else if (message.event === 'media') {
        // Echo back audio (for testing)
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            event: 'media',
            streamSid: message.streamSid,
            media: {
              payload: message.media.payload
            }
          }));
        }
      } else if (message.event === 'stop') {
        log('Stream stopped');
      }
    } catch (error) {
      log('Error processing message:', error);
    }
  });
  
  ws.on('close', () => {
    log('SignalWire WebSocket disconnected');
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    activeConnections: wss.clients.size
  });
});

// Start server
server.listen(PORT, () => {
  log(`Server running on port ${PORT}`);
  log('Environment variables loaded:');
  log(`- OPENAI_API_KEY: ${OPENAI_API_KEY ? '✓' : '✗'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    log('Server closed');
    process.exit(0);
  });
});
