import { createServer } from 'node:http';

const PORT = parseInt(process.env.PORT ?? '8080', 10);

const server = createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'healthy', timestamp: new Date().toISOString() }));
        return;
    }

    if (req.url === '/v1/agent/turn' && req.method === 'POST') {
        res.writeHead(501, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Agent not implemented yet' }));
        return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`[agent-core] Server listening on port ${PORT}`);
    console.log(`[agent-core] Health check: http://localhost:${PORT}/health`);
});

