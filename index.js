import express from 'express';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import fetch from 'node-fetch';
import twilio from 'twilio';
import bodyParser from 'body-parser';
import { createServer } from 'http';
import { URL } from 'url';
import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

// Load environment variables
const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SIGNALWIRE_PROJECT_KEY = process.env.SIGNALWIRE_PROJECT_KEY;
const SIGNALWIRE_TOKEN = process.env.SIGNALWIRE_TOKEN;

// Validate required environment variables
if (!OPENAI_API_KEY || !SIGNALWIRE_PROJECT_KEY || !SIGNALWIRE_TOKEN) {
  console.error('Missing required environment variables:');
  console.error('Required: OPENAI_API_KEY, SIGNALWIRE_PROJECT_KEY, SIGNALWIRE_TOKEN');
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
    log('OpenAI session created successfully');
    return session;
  } catch (error) {
    log('Error creating OpenAI session:', error);
    throw error;
  }
}

// POST /voice endpoint - Returns SignalWire LAML to connect to WebSocket
app.post('/voice', (req, res) => {
  log('Received voice request');
  
  const response = new twilio.twiml.VoiceResponse();
  
  // Create WebSocket URL for this call
  const protocol = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers.host;
  const wsUrl = `${protocol === 'https' ? 'wss' : 'ws'}://${host}/media-stream`;
  
  log(`Connecting to WebSocket: ${wsUrl}`);
  
  // Connect to WebSocket media stream
  const connect = response.connect();
  connect.stream({ url: wsUrl });
  
  res.type('text/xml');
  res.send(response.toString());
});

// WebSocket endpoint for SignalWire Media Stream
wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  
  if (url.pathname !== '/media-stream') {
    log('Invalid WebSocket path:', url.pathname);
    ws.close();
    return;
  }
  
  log('SignalWire WebSocket connection established');
  
  let openAIWS = null;
  let sessionId = null;
  let openAIReady = false;
  
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
    
    openAIConnections.set(sessionId, { openAIWS, twilioWS: ws });
    
    // Handle OpenAI WebSocket connection
    openAIWS.on('open', () => {
      log('OpenAI WebSocket connected');
      
      // Send initial session.update event
      openAIWS.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['audio', 'text'],
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
    });
    
    openAIWS.on('message', (data) => {
      try {
        const event = JSON.parse(data.toString());
        log(`Received from OpenAI: ${event.type}`);
        
        if (event.type === 'session.created') {
          log('OpenAI session created', { session_id: event.session.id });
        } else if (event.type === 'session.updated') {
          log('OpenAI session updated - ready for audio');
          openAIReady = true;
          
          // Send audio notification to agent
          if (ws.readyState === WebSocket.OPEN) {
            // Generate a beep tone
            const beepTone = generateBeepTone();
            
            ws.send(JSON.stringify({
              event: 'media',
              streamSid: event.session.id,
              media: {
                payload: beepTone,
              },
            }));
            
            // Send spoken notification
            setTimeout(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  event: 'say',
                  streamSid: event.session.id,
                  text: 'Translator ready',
                }));
              }
            }, 500);
          }
        } else if (event.type === 'output_audio_chunk.delta') {
          // Forward audio chunks to SignalWire
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              event: 'media',
              streamSid: event.stream_sid,
              media: {
                payload: event.delta,
              },
            }));
          }
        } else if (event.type === 'error') {
          log('OpenAI error:', event);
        }
      } catch (error) {
        log('Error processing OpenAI message:', error);
      }
    });
    
    openAIWS.on('close', () => {
      log('OpenAI WebSocket closed');
      openAIReady = false;
      openAIConnections.delete(sessionId);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    });
    
    openAIWS.on('error', (error) => {
      log('OpenAI WebSocket error:', error);
      openAIReady = false;
      openAIConnections.delete(sessionId);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    });
    
  } catch (error) {
    log('Error setting up OpenAI connection:', error);
    ws.close();
    return;
  }
  
  // Handle SignalWire WebSocket messages
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      log(`Received from SignalWire: ${message.event}`);
      
      if (message.event === 'start') {
        log('SignalWire stream started', { streamSid: message.start.streamSid });
      } else if (message.event === 'media') {
        // Only forward audio to OpenAI if ready
        if (openAIReady && openAIWS && openAIWS.readyState === WebSocket.OPEN) {
          openAIWS.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: message.media.payload,
          }));
        } else {
          log('OpenAI WebSocket not ready for audio - skipping chunk');
        }
      } else if (message.event === 'stop') {
        log('SignalWire stream stopped');
        if (openAIWS && openAIWS.readyState === WebSocket.OPEN) {
          openAIWS.close();
        }
      }
    } catch (error) {
      log('Error processing SignalWire message:', error);
    }
  });
  
  ws.on('close', () => {
    log('SignalWire WebSocket closed');
    openAIReady = false;
    if (openAIWS && openAIWS.readyState === WebSocket.OPEN) {
      openAIWS.close();
    }
    if (sessionId) {
      openAIConnections.delete(sessionId);
    }
  });
  
  ws.on('error', (error) => {
    log('SignalWire WebSocket error:', error);
    openAIReady = false;
    if (openAIWS && openAIWS.readyState === WebSocket.OPEN) {
      openAIWS.close();
    }
    if (sessionId) {
      openAIConnections.delete(sessionId);
    }
  });
});

// Helper function to generate a beep tone
function generateBeepTone(frequency = 800, duration = 0.1, sampleRate = 8000) {
  const samples = Math.floor(sampleRate * duration);
  const tone = new Float32Array(samples);
  
  for (let i = 0; i < samples; i++) {
    tone[i] = Math.sin(2 * Math.PI * frequency * i / sampleRate) * 0.3;
  }
  
  // Convert to 16-bit PCM
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    pcm[i] = Math.floor(tone[i] * 32767);
  }
  
  // Convert to base64
  return Buffer.from(pcm.buffer).toString('base64');
}

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
  log(`- SIGNALWIRE_PROJECT_KEY: ${SIGNALWIRE_PROJECT_KEY ? '✓' : '✗'}`);
  log(`- SIGNALWIRE_TOKEN: ${SIGNALWIRE_TOKEN ? '✓' : '✗'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    log('Server closed');
    process.exit(0);
  });
});
