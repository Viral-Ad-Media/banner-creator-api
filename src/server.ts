import 'dotenv/config';
import { app } from './app.js';
import { env } from './config/env.js';

const server = app.listen(env.PORT, () => {
  console.log(`Backend API running on http://localhost:${env.PORT}`);
});

const shutdown = (signal: string) => {
  console.log(`Received ${signal}. Shutting down backend...`);
  server.close(() => {
    process.exit(0);
  });
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
