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
  log('📞 Voice request received');
  
  const xmlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/signalwire-media"/>
  </Connect>
</Response>`;
  
  res.type('text/xml');
  res.send(xmlResponse);
});

// WebSocket with OpenAI translation
wss.on('connection', async (ws, req) => {
  if (req.url !== '/signalwire-media') {
    ws.close();
    return;
  }
  
  log('🔌 WebSocket connected');
  
  let openAIWS = null;
  let streamSid = null;
  let sessionConfigured = false;
  
  try {
    // Create OpenAI session
    const sessionResponse = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-realtime-preview-2024-12-17',
        voice: 'verse',
      }),
    });
    
    const session = await sessionResponse.json();
    log('✅ OpenAI session created');
    
    // Connect to OpenAI WebSocket
    openAIWS = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });
    
    openAIWS.on('open', () => {
      log('✅ OpenAI WebSocket connected');
      
      // Configure translation session
      openAIWS.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['audio'],
          instructions: 'You are a live interpreter. Translate English to Spanish and Spanish to English in real-time. Speak naturally.',
          voice: 'verse',
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_transcription: { model: 'whisper-1' },
          turn_detection: { type: 'server_vad', threshold: 0.5 },
        },
      }));
      sessionConfigured = true;
      log('🎯 Translation session configured');
    });
    
    openAIWS.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString());
        
        if (event.type === 'output_audio_chunk.delta' && streamSid) {
          // Send translated audio to SignalWire
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              event: 'media',
              streamSid: streamSid,
              media: { payload: event.delta },
            }));
          }
        } else if (event.type === 'session.created') {
          log('🎯 Session active');
        }
      } catch (error) {
        log('❌ OpenAI message error:', error);
      }
    });
    
    // Handle SignalWire audio
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        
        if (message.event === 'start') {
          streamSid = message.start.streamSid;
          log('🎤 Audio stream started');
        } else if (message.event === 'media' && sessionConfigured) {
          // Send to OpenAI for translation
          if (openAIWS.readyState === WebSocket.OPEN) {
            openAIWS.send(JSON.stringify({
              type: 'input_audio_buffer.append',
              audio: message.media.payload,
            }));
          }
        }
      } catch (error) {
        log('❌ SignalWire message error:', error);
      }
    });
    
    ws.on('close', () => {
      log('🔌 WebSocket disconnected');
      if (openAIWS.readyState === WebSocket.OPEN) {
        openAIWS.close();
      }
    });
    
  } catch (error) {
    log('❌ Translation setup error:', error);
    ws.close();
  }
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
  log(`🌍 PHONE TRANSLATOR READY on port ${PORT}`);
  log('📞 Speak English → Hear Spanish');
  log('📞 Speak Spanish → Hear English');
});

process.on('SIGTERM', () => {
  log('🛑 Shutting down');
  server.close(() => process.exit(0));
});
