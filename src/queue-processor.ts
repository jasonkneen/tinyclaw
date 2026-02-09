#!/usr/bin/env node
/**
 * Queue Processor - Handles messages from all channels (WhatsApp, Telegram, etc.)
 * Processes one message at a time to avoid race conditions
 */

import { execSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import crypto from 'crypto';

const SCRIPT_DIR = path.resolve(__dirname, '..');
const QUEUE_INCOMING = path.join(SCRIPT_DIR, '.tinyclaw/queue/incoming');
const QUEUE_OUTGOING = path.join(SCRIPT_DIR, '.tinyclaw/queue/outgoing');
const QUEUE_PROCESSING = path.join(SCRIPT_DIR, '.tinyclaw/queue/processing');
const LOG_FILE = path.join(SCRIPT_DIR, '.tinyclaw/logs/queue.log');
const RESET_FLAG = path.join(SCRIPT_DIR, '.tinyclaw/reset_flag');
const MODEL_CONFIG = path.join(SCRIPT_DIR, '.tinyclaw/model');
const SETTINGS_FILE = path.join(SCRIPT_DIR, '.tinyclaw/settings.json');
const DEFAULT_WEBHOOK_PORT = 3077;

// Model name mapping
const MODEL_IDS: Record<string, string> = {
    'sonnet': 'claude-sonnet-4-5',
    'opus': 'claude-opus-4-6',
};

function getModelFlag(): string {
    try {
        const model = fs.readFileSync(MODEL_CONFIG, 'utf8').trim();
        const modelId = MODEL_IDS[model];
        if (modelId) {
            return `--model ${modelId} `;
        }
    } catch { }
    return '';
}

// Ensure directories exist
[QUEUE_INCOMING, QUEUE_OUTGOING, QUEUE_PROCESSING, path.dirname(LOG_FILE)].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

interface MessageData {
    channel: string;
    sender: string;
    senderId?: string;
    message: string;
    timestamp: number;
    messageId: string;
}

interface ResponseData {
    channel: string;
    sender: string;
    message: string;
    originalMessage: string;
    timestamp: number;
    messageId: string;
}

// Logger
function log(level: string, message: string): void {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}\n`;
    console.log(logMessage.trim());
    fs.appendFileSync(LOG_FILE, logMessage);
}

// Process a single message
async function processMessage(messageFile: string): Promise<void> {
    const processingFile = path.join(QUEUE_PROCESSING, path.basename(messageFile));

    try {
        // Move to processing to mark as in-progress
        fs.renameSync(messageFile, processingFile);

        // Read message
        const messageData: MessageData = JSON.parse(fs.readFileSync(processingFile, 'utf8'));
        const { channel, sender, message, timestamp, messageId } = messageData;

        log('INFO', `Processing [${channel}] from ${sender}: ${message.substring(0, 50)}...`);

        // Check if we should reset conversation (start fresh without -c)
        const shouldReset = fs.existsSync(RESET_FLAG);
        const continueFlag = shouldReset ? '' : '-c ';

        if (shouldReset) {
            log('INFO', '🔄 Resetting conversation (starting fresh without -c)');
            fs.unlinkSync(RESET_FLAG);
        }

        // Call Claude
        let response: string;
        try {
            const modelFlag = getModelFlag();
            response = execSync(
                `cd "${SCRIPT_DIR}" && claude --dangerously-skip-permissions ${modelFlag}${continueFlag}-p "${message.replace(/"/g, '\\"')}"`,
                {
                    encoding: "utf-8",
                    timeout: 120000, // 2 minute timeout
                    maxBuffer: 10 * 1024 * 1024, // 10MB buffer
                },
            );
        } catch (error) {
            log('ERROR', `Claude error: ${(error as Error).message}`);
            response = "Sorry, I encountered an error processing your request.";
        }

        // Clean response
        response = response.trim();

        // Limit response length
        if (response.length > 4000) {
            response = response.substring(0, 3900) + '\n\n[Response truncated...]';
        }

        // Write response to outgoing queue
        const responseData: ResponseData = {
            channel,
            sender,
            message: response,
            originalMessage: message,
            timestamp: Date.now(),
            messageId
        };

        // For heartbeat messages, write to a separate location (they handle their own responses)
        const responseFile = channel === 'heartbeat'
            ? path.join(QUEUE_OUTGOING, `${messageId}.json`)
            : path.join(QUEUE_OUTGOING, `${channel}_${messageId}_${Date.now()}.json`);

        fs.writeFileSync(responseFile, JSON.stringify(responseData, null, 2));

        log('INFO', `✓ Response ready [${channel}] ${sender} (${response.length} chars)`);

        // Clean up processing file
        fs.unlinkSync(processingFile);

    } catch (error) {
        log('ERROR', `Processing error: ${(error as Error).message}`);

        // Move back to incoming for retry
        if (fs.existsSync(processingFile)) {
            try {
                fs.renameSync(processingFile, messageFile);
            } catch (e) {
                log('ERROR', `Failed to move file back: ${(e as Error).message}`);
            }
        }
    }
}

interface QueueFile {
    name: string;
    path: string;
    time: number;
}

// Main processing loop
async function processQueue(): Promise<void> {
    try {
        // Get all files from incoming queue, sorted by timestamp
        const files: QueueFile[] = fs.readdirSync(QUEUE_INCOMING)
            .filter(f => f.endsWith('.json'))
            .map(f => ({
                name: f,
                path: path.join(QUEUE_INCOMING, f),
                time: fs.statSync(path.join(QUEUE_INCOMING, f)).mtimeMs
            }))
            .sort((a, b) => a.time - b.time);

        if (files.length > 0) {
            log('DEBUG', `Found ${files.length} message(s) in queue`);

            // Process one at a time
            for (const file of files) {
                await processMessage(file.path);
            }
        }
    } catch (error) {
        log('ERROR', `Queue processing error: ${(error as Error).message}`);
    }
}

// ─── Webhook HTTP Server ───────────────────────────────────────────────────

interface WebhookMessageBody {
    channel: string;
    sender: string;
    senderId?: string;
    message: string;
    timestamp?: number;
    messageId?: string;
}

interface WebhookResponse {
    success: boolean;
    messageId?: string;
    error?: string;
}

function getWebhookPort(): number {
    try {
        const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        if (settings.webhook_port && typeof settings.webhook_port === 'number') {
            return settings.webhook_port;
        }
    } catch { }
    return DEFAULT_WEBHOOK_PORT;
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const MAX_BODY = 1024 * 1024; // 1MB limit

        req.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BODY) {
                req.destroy();
                reject(new Error('Request body too large'));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function sendJson(res: http.ServerResponse, statusCode: number, data: object): void {
    const body = JSON.stringify(data, null, 2);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
}

function handleWebhookMessage(body: WebhookMessageBody): WebhookResponse {
    // Validate required fields
    if (!body.channel || typeof body.channel !== 'string') {
        return { success: false, error: 'Missing or invalid "channel" field' };
    }
    if (!body.sender || typeof body.sender !== 'string') {
        return { success: false, error: 'Missing or invalid "sender" field' };
    }
    if (!body.message || typeof body.message !== 'string') {
        return { success: false, error: 'Missing or invalid "message" field' };
    }

    const timestamp = body.timestamp || Date.now();
    const messageId = body.messageId || `${body.channel}_${timestamp}_${crypto.randomBytes(4).toString('hex')}`;

    const messageData: MessageData = {
        channel: body.channel,
        sender: body.sender,
        senderId: body.senderId || `webhook_${body.sender}`,
        message: body.message,
        timestamp,
        messageId,
    };

    const filename = `${body.channel}_${timestamp}_${crypto.randomBytes(4).toString('hex')}.json`;
    const filePath = path.join(QUEUE_INCOMING, filename);

    fs.writeFileSync(filePath, JSON.stringify(messageData, null, 2));

    log('INFO', `[webhook] Queued message [${body.channel}] from ${body.sender}: ${body.message.substring(0, 50)}...`);

    return { success: true, messageId };
}

function getMessageStatus(messageId: string): { status: string; data?: object } {
    // Check outgoing (completed)
    const outFiles = fs.readdirSync(QUEUE_OUTGOING).filter(f => f.endsWith('.json'));
    for (const f of outFiles) {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(QUEUE_OUTGOING, f), 'utf8'));
            if (data.messageId === messageId) {
                return { status: 'completed', data };
            }
        } catch { }
    }

    // Check processing (in progress)
    const procFiles = fs.readdirSync(QUEUE_PROCESSING).filter(f => f.endsWith('.json'));
    for (const f of procFiles) {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(QUEUE_PROCESSING, f), 'utf8'));
            if (data.messageId === messageId) {
                return { status: 'processing' };
            }
        } catch { }
    }

    // Check incoming (queued)
    const inFiles = fs.readdirSync(QUEUE_INCOMING).filter(f => f.endsWith('.json'));
    for (const f of inFiles) {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(QUEUE_INCOMING, f), 'utf8'));
            if (data.messageId === messageId) {
                return { status: 'queued' };
            }
        } catch { }
    }

    return { status: 'not_found' };
}

function startWebhookServer(): void {
    const port = getWebhookPort();

    const server = http.createServer(async (req, res) => {
        const url = req.url || '/';
        const method = req.method || 'GET';

        // CORS headers for broad compatibility
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        // POST /webhook/message — queue a new message
        if (method === 'POST' && url === '/webhook/message') {
            try {
                const rawBody = await readRequestBody(req);
                const body: WebhookMessageBody = JSON.parse(rawBody);
                const result = handleWebhookMessage(body);
                sendJson(res, result.success ? 200 : 400, result);
            } catch (error) {
                sendJson(res, 400, { success: false, error: 'Invalid JSON body' });
            }
            return;
        }

        // GET /webhook/health — health check
        if (method === 'GET' && url === '/webhook/health') {
            const incomingCount = fs.readdirSync(QUEUE_INCOMING).filter(f => f.endsWith('.json')).length;
            const processingCount = fs.readdirSync(QUEUE_PROCESSING).filter(f => f.endsWith('.json')).length;
            const outgoingCount = fs.readdirSync(QUEUE_OUTGOING).filter(f => f.endsWith('.json')).length;

            sendJson(res, 200, {
                status: 'ok',
                uptime: process.uptime(),
                queue: {
                    incoming: incomingCount,
                    processing: processingCount,
                    outgoing: outgoingCount,
                },
            });
            return;
        }

        // GET /webhook/status/:messageId — check message status
        const statusMatch = url.match(/^\/webhook\/status\/(.+)$/);
        if (method === 'GET' && statusMatch) {
            const messageId = decodeURIComponent(statusMatch[1]);
            const result = getMessageStatus(messageId);
            const statusCode = result.status === 'not_found' ? 404 : 200;
            sendJson(res, statusCode, result);
            return;
        }

        // 404 for everything else
        sendJson(res, 404, { error: 'Not found' });
    });

    server.listen(port, () => {
        log('INFO', `Webhook server listening on port ${port}`);
        log('INFO', `  POST http://localhost:${port}/webhook/message`);
        log('INFO', `  GET  http://localhost:${port}/webhook/health`);
        log('INFO', `  GET  http://localhost:${port}/webhook/status/:messageId`);
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
            log('ERROR', `Webhook port ${port} is already in use. Webhook server disabled.`);
        } else {
            log('ERROR', `Webhook server error: ${err.message}`);
        }
    });
}

// ─── Main Loop ─────────────────────────────────────────────────────────────

log('INFO', 'Queue processor started');
log('INFO', `Watching: ${QUEUE_INCOMING}`);

// Start webhook HTTP server
startWebhookServer();

// Process queue every 1 second
setInterval(processQueue, 1000);

// Graceful shutdown
process.on('SIGINT', () => {
    log('INFO', 'Shutting down queue processor...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    log('INFO', 'Shutting down queue processor...');
    process.exit(0);
});
