import express from 'express';
import bodyParser from 'body-parser';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import fetch from 'node-fetch';

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY');
  process.exit(1);
}

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

function log(message, data = '') {
  const timestamp = new Date().toISOString();
  console.log(`🕐 [${timestamp}] ${message}`, data ? JSON.stringify(data, null, 2) : '');
}

// POST /voice endpoint
app.post('/voice', (req, res) => {
  log('📞 Received SignalWire voice request');
  log('📋 Request body:', req.body);
  
  const xmlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/signalwire-media"/>
  </Connect>
</Response>`;
  
  log('📤 Sending XML response');
  res.type('text/xml');
  res.send(xmlResponse);
});

// WebSocket endpoint
wss.on('connection', async (ws, req) => {
  if (req.url !== '/signalwire-media') {
    log('❌ Wrong WebSocket path:', req.url);
    ws.close();
    return;
  }
  
  log('🔌 SignalWire WebSocket connected');
  let streamSid = null;
  
  // Simple echo test first
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      log('📨 Received from SignalWire:', message.event);
      
      if (message.event === 'start') {
        streamSid = message.start.streamSid;
        log('🎯 Stream started:', { streamSid });
        
        // Send test audio back immediately
        const testAudio = Buffer.from('Hello! Translator connected.').toString('base64');
        ws.send(JSON.stringify({
          event: 'media',
          streamSid: streamSid,
          media: { payload: testAudio }
        }));
        
      } else if (message.event === 'media') {
        log('🎤 Audio received, echoing back');
        
        // Echo the audio back
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            event: 'media',
            streamSid: streamSid,
            media: { payload: message.media.payload }
          }));
        }
      }
    } catch (error) {
      log('❌ Error processing message:', error);
    }
  });
  
  ws.on('close', () => {
    log('🔌 SignalWire WebSocket disconnected');
  });
  
  ws.on('error', (error) => {
    log('❌ WebSocket error:', error);
  });
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    activeConnections: wss.clients.size
  });
});

server.listen(PORT, () => {
  log(`🌍 Phone Translator running on port ${PORT}`);
  log('📞 Ready for calls!');
});

process.on('SIGTERM', () => {
  log('🛑 Shutting down gracefully');
  server.close(() => process.exit(0));
});
