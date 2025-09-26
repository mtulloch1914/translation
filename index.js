// WebSocket endpoint for Twilio Media Stream
wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  
  if (url.pathname !== '/twilio-media') {
    log('Invalid WebSocket path:', url.pathname);
    ws.close();
    return;
  }
  
  log('Twilio WebSocket connection established');
  
  let openAIWS = null;
  let sessionId = null;
  let openAIReady = false; // Add this flag to track OpenAI readiness
  
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
          modalities: ['audio', 'text'], // Fixed: include both modalities
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
          log('✅ OpenAI session updated and ready for audio');
          openAIReady = true; // Set flag when session is ready
        } else if (event.type === 'output_audio_chunk.delta') {
          // Forward audio chunks to Twilio
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
      openAIReady = false; // Reset flag when connection closes
      openAIConnections.delete(sessionId);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    });
    
    openAIWS.on('error', (error) => {
      log('OpenAI WebSocket error:', error);
      openAIReady = false; // Reset flag on error
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
  
  // Handle Twilio WebSocket messages
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      log(`Received from Twilio: ${message.event}`);
      
      if (message.event === 'start') {
        log('Twilio stream started', { streamSid: message.start.streamSid });
      } else if (message.event === 'media') {
        // Only forward audio to OpenAI if it's ready
        if (openAIWS && openAIWS.readyState === WebSocket.OPEN && openAIReady) {
          openAIWS.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: message.media.payload,
          }));
          log(`📤 Audio chunk forwarded to OpenAI`);
        } else {
          log(`❌ OpenAI WebSocket not ready for audio (ready: ${openAIReady}, state: ${openAIWS?.readyState})`);
        }
      } else if (message.event === 'stop') {
        log('Twilio stream stopped');
        if (openAIWS && openAIWS.readyState === WebSocket.OPEN) {
          openAIWS.close();
        }
      }
    } catch (error) {
      log('Error processing Twilio message:', error);
    }
  });
  
  ws.on('close', () => {
    log('Twilio WebSocket closed');
    if (openAIWS && openAIWS.readyState === WebSocket.OPEN) {
      openAIWS.close();
    }
    if (sessionId) {
      openAIConnections.delete(sessionId);
    }
  });
  
  ws.on('error', (error) => {
    log('Twilio WebSocket error:', error);
    if (openAIWS && openAIWS.readyState === WebSocket.OPEN) {
      openAIWS.close();
    }
    if (sessionId) {
      openAIConnections.delete(sessionId);
    }
  });
});
