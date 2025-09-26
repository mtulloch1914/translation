import express from 'express';
import bodyParser from 'body-parser';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import fetch from 'node-fetch';

// Load environment variables
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY');
  process.exit(1);
}

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

function log(message, data = '') {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`, data ? JSON.stringify(data, null, 2) : '');
}

// POST /voice endpoint
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

// WebSocket endpoint for real-time translation
wss.on('connection', async (ws, req) => {
  if (req.url !== '/signalwire-media') {
    ws.close();
    return;
  }
  
  log('SignalWire WebSocket connected - Starting translator');
  
  let openAIWS = null;
  let streamSid = null;
  
  try {
    // Create OpenAI Realtime session
    const sessionResponse = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-realtime-preview-2024-12-17',
        voice: 'verse',
        instructions: 'You are a live interpreter. Translate English to Spanish and Spanish to English in real-time. Respond only with the translation.',
      }),
    });
    
    const session = await sessionResponse.json();
    log('OpenAI session created');
    
    // Connect to OpenAI WebSocket
    openAIWS = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });
    
    openAIWS.on('open', () => {
      log('OpenAI WebSocket connected');
      
      // Configure session
      openAIWS.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['audio'],
          instructions: 'You are a live interpreter. Translate English to Spanish and Spanish to English in real-time. Respond only with the translation audio.',
          voice: 'verse',
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
        },
      }));
    });
    
    openAIWS.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString());
        
        if (event.type === 'output_audio_chunk.delta') {
          // Send translated audio back to SignalWire
          if (ws.readyState === WebSocket.OPEN && streamSid) {
            ws.send(JSON.stringify({
              event: 'media',
              streamSid: streamSid,
              media: {
                payload: event.delta,
              },
            }));
          }
        }
      } catch (error) {
        log('Error processing OpenAI message:', error);
      }
    });
    
    // Handle SignalWire messages
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        log(`Received: ${message.event}`);
        
        if (message.event === 'start') {
          streamSid = message.start.streamSid;
          log('Stream started', { streamSid });
        } else if (message.event === 'media' && openAIWS.readyState === WebSocket.OPEN) {
          // Send audio to OpenAI for translation
          openAIWS.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: message.media.payload,
          }));
        }
      } catch (error) {
        log('Error processing SignalWire message:', error);
      }
    });
    
    ws.on('close', () => {
      log('SignalWire WebSocket disconnected');
      if (openAIWS.readyState === WebSocket.OPEN) {
        openAIWS.close();
      }
    });
    
  } catch (error) {
    log('Error setting up translation:', error);
    ws.close();
  }
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
  log(`🌍 Phone Translator running on port ${PORT}`);
  log('📞 Ready for calls!');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    log('Server closed');
    process.exit(0);
  });
});
