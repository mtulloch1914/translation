import express from 'express';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import fetch from 'node-fetch';
import bodyParser from 'body-parser';
import { createServer } from 'http';

// Load environment variables
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SIGNALWIRE_PROJECT_ID = process.env.SIGNALWIRE_PROJECT_ID;
const SIGNALWIRE_API_TOKEN = process.env.SIGNALWIRE_API_TOKEN;
const SIGNALWIRE_SPACE_URL = process.env.SIGNALWIRE_SPACE_URL;

// Validate required environment variables
if (!OPENAI_API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY');
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

// Create OpenAI Realtime session
async function createOpenAISession() {
  try {
    const response = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-realtime-preview-2024-12-17',
        voice: 'verse',
        instructions: 'You are a live interpreter. Translate English → Spanish and Spanish → English in real time. Respond only with the translation audio.',
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
    }

    const session = await response.json();
    log('✅ OpenAI session created successfully');
    return session;
  } catch (error) {
    log('❌ Error creating OpenAI session:', error);
    throw error;
  }
}

// POST /voice endpoint - Returns SignalWire XML
app.post('/voice', (req, res) => {
  log('📞 Received SignalWire voice request');
  
  // Create WebSocket URL for this call
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host;
  const wsUrl = `${protocol === 'https' ? 'wss' : 'ws'}://${host}/signalwire-media`;
  
  log(`🔗 Connecting to WebSocket: ${wsUrl}`);
  
  // SignalWire XML Response
  const xmlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}"/>
  </Connect>
</Response>`;
  
  res.type('text/xml');
  res.send(xmlResponse);
});

// WebSocket endpoint for SignalWire Media Stream
wss.on('connection', async (ws, req) => {
  if (req.url !== '/signalwire-media') {
    log('❌ Invalid WebSocket path:', req.url);
    ws.close();
    return;
  }
  
  log('🔌 SignalWire WebSocket connection established');
  
  let openAIWS = null;
  let sessionId = null;
  let streamSid = null;
  let audioChunksReceived = 0;
  let audioChunksSent = 0;
  
  try {
    // Create OpenAI session
    const session = await createOpenAISession();
    sessionId = session.id;
    
    // Connect to OpenAI Realtime API
    openAIWS = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    });
    
    // Handle OpenAI WebSocket connection
    openAIWS.on('open', () => {
      log('🎯 OpenAI WebSocket connected');
      
      // Configure translation session
      openAIWS.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['audio'],
          instructions: 'You are a live interpreter. Translate English → Spanish and Spanish → English in real time. Respond only with the translation audio.',
          voice: 'verse',
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_transcription: {
            model: 'whisper-1',
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 200,
          },
        },
      }));
      log('🎯 Translation session configured');
    });
    
    openAIWS.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString());
        
        if (event.type === 'session.created') {
          log('🎯 OpenAI session active', { session_id: event.session.id });
        } else if (event.type === 'output_audio_chunk.delta') {
          audioChunksSent++;
          log(`🔊 Translation audio chunk #${audioChunksSent} received from OpenAI`);
          
          // Forward translation audio to SignalWire
          if (ws.readyState === WebSocket.OPEN && streamSid) {
            ws.send(JSON.stringify({
              event: 'media',
              streamSid: streamSid,
              media: {
                payload: event.delta,
              },
            }));
            log(`📤 Translation audio chunk #${audioChunksSent} sent to caller`);
          }
        } else if (event.type === 'error') {
          log('❌ OpenAI error:', event);
        } else if (event.type === 'input_audio_buffer.speech_started') {
          log('🎤 Speech detected in input audio');
        } else if (event.type === 'input_audio_buffer.speech_stopped') {
          log('🔇 Speech ended in input audio');
        }
      } catch (error) {
        log('❌ Error processing OpenAI message:', error);
      }
    });
    
    openAIWS.on('close', () => {
      log('🎯 OpenAI WebSocket closed');
    });
    
    openAIWS.on('error', (error) => {
      log('❌ OpenAI WebSocket error:', error);
    });
    
  } catch (error) {
    log('❌ Error setting up OpenAI connection:', error);
    ws.close();
    return;
  }
  
  // Handle SignalWire WebSocket messages
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      
      if (message.event === 'start') {
        streamSid = message.start.streamSid;
        log('🎤 SignalWire stream started', { streamSid: streamSid });
      } else if (message.event === 'media') {
        audioChunksReceived++;
        log(`🎤 Audio chunk #${audioChunksReceived} received from caller`);
        
        // Forward audio to OpenAI for translation
        if (openAIWS && openAIWS.readyState === WebSocket.OPEN) {
          openAIWS.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: message.media.payload,
          }));
          log(`📤 Audio chunk #${audioChunksReceived} forwarded to OpenAI`);
        } else {
          log('❌ OpenAI WebSocket not ready for audio');
        }
      } else if (message.event === 'stop') {
        log('🛑 SignalWire stream stopped');
        if (openAIWS && openAIWS.readyState === WebSocket.OPEN) {
          openAIWS.close();
        }
      }
    } catch (error) {
      log('❌ Error processing SignalWire message:', error);
    }
  });
  
  ws.on('close', () => {
    log(`🔌 SignalWire WebSocket closed. Total: ${audioChunksReceived} received, ${audioChunksSent} translation chunks sent`);
    if (openAIWS && openAIWS.readyState === WebSocket.OPEN) {
      openAIWS.close();
    }
  });
  
  ws.on('error', (error) => {
    log('❌ SignalWire WebSocket error:', error);
    if (openAIWS && openAIWS.readyState === WebSocket.OPEN) {
      openAIWS.close();
    }
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
  log(`🌍 PHONE TRANSLATOR READY on port ${PORT}`);
  log('📞 Speak English → Hear Spanish');
  log('📞 Speak Spanish → Hear English');
  log(`✅ Environment: OPENAI_API_KEY loaded`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log('🛑 SIGTERM received, shutting down gracefully');
  server.close(() => {
    log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  log('🛑 SIGINT received, shutting down gracefully');
  server.close(() => {
    log('Server closed');
    process.exit(0);
  });
});
