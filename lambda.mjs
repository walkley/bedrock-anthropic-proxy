/**
 * Anthropic-compatible API proxy backed by AWS Bedrock.
 *
 * Accepts Anthropic Messages API requests, forwards them to Bedrock Runtime,
 * and returns Bedrock responses in Anthropic-compatible format.
 * Supports both streaming (SSE) and non-streaming responses.
 *
 * Authentication: The client sends a Bedrock API Key via x-api-key header
 * (same as Anthropic SDK). We pass it through to Bedrock as a Bearer token.
 *
 * The model field is passed directly to Bedrock as the modelId, so clients
 * should use Bedrock inference profile IDs (e.g. us.anthropic.claude-sonnet-4-6).
 *
 * Route: POST /v1/messages
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';

// ─── Auth ────────────────────────────────────────────────────────────────────

function extractApiKey(event) {
  const headers = event.headers || {};
  const norm = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return norm['x-api-key'] || null;
}

function createBedrockClient(apiKey) {
  const client = new BedrockRuntimeClient();
  client.middlewareStack.add(
    (next) => async (args) => {
      args.request.headers['authorization'] = `Bearer ${apiKey}`;
      delete args.request.headers['x-amz-security-token'];
      return next(args);
    },
    { step: 'finalizeRequest', name: 'bedrockApiKeyAuth', override: true }
  );
  return client;
}

// ─── Bedrock calls ───────────────────────────────────────────────────────────

function buildBedrockBody(body) {
  const b = { ...body };
  delete b.model;
  delete b.stream;
  b.anthropic_version = 'bedrock-2023-05-31';
  return b;
}

async function invokeModel(client, body) {
  const command = new InvokeModelCommand({
    modelId: body.model,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(buildBedrockBody(body)),
  });
  const res = await client.send(command);
  const decoded = JSON.parse(new TextDecoder().decode(res.body));
  decoded.model = body.model;
  return decoded;
}

async function* invokeModelStream(client, body) {
  const command = new InvokeModelWithResponseStreamCommand({
    modelId: body.model,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify(buildBedrockBody(body)),
  });
  const res = await client.send(command);
  for await (const event of res.body) {
    if (event.chunk?.bytes) {
      const chunk = JSON.parse(new TextDecoder().decode(event.chunk.bytes));
      if (chunk.type === 'message_start' && chunk.message) {
        chunk.message.model = body.model;
      }
      yield `event: ${chunk.type}\ndata: ${JSON.stringify(chunk)}\n\n`;
    }
  }
}


// ─── Lambda handler ──────────────────────────────────────────────────────────

function writeError(responseStream, statusCode, errorType, message) {
  responseStream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
  responseStream.write(JSON.stringify({ type: 'error', error: { type: errorType, message } }));
  responseStream.end();
}

function parseBody(event) {
  let raw = event.body || '{}';
  if (event.isBase64Encoded) raw = Buffer.from(raw, 'base64').toString('utf-8');
  return JSON.parse(raw);
}

export const handler = awslambda.streamifyResponse(async (event, responseStream, _context) => {
  const apiKey = extractApiKey(event);
  if (!apiKey) {
    writeError(responseStream, 401, 'authentication_error', 'Missing API key. Provide via x-api-key header.');
    return;
  }

  const path = event.rawPath || event.path || '';
  const method = event.requestContext?.http?.method || event.httpMethod || '';
  if (method !== 'POST' || !path.endsWith('/v1/messages')) {
    writeError(responseStream, 404, 'not_found_error', `Route not found: ${method} ${path}`);
    return;
  }

  let body;
  try { body = parseBody(event); } catch {
    writeError(responseStream, 400, 'invalid_request_error', 'Invalid JSON in request body');
    return;
  }

  if (!body.model) { writeError(responseStream, 400, 'invalid_request_error', 'model is required'); return; }
  if (!body.max_tokens) { writeError(responseStream, 400, 'invalid_request_error', 'max_tokens is required'); return; }

  const client = createBedrockClient(apiKey);

  try {
    if (body.stream === true) {
      responseStream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 200,
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*' },
      });
      for await (const chunk of invokeModelStream(client, body)) responseStream.write(chunk);
      responseStream.end();
    } else {
      const result = await invokeModel(client, body);
      responseStream = awslambda.HttpResponseStream.from(responseStream, {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
      responseStream.write(JSON.stringify(result));
      responseStream.end();
    }
  } catch (err) {
    console.error('Bedrock invocation error:', err);
    const sc = err.$metadata?.httpStatusCode || 500;
    writeError(responseStream, sc, sc === 400 ? 'invalid_request_error' : 'api_error', err.message || 'Internal server error');
  }
});
