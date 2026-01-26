// Entry point for running the bot directly (npm run start:15min)
import { PolymarketBot15Min } from './bot-15min.js';

const bot = new PolymarketBot15Min();
bot.start().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});

process.on("SIGINT", () => bot.stop());
process.on("SIGTERM", () => bot.stop());
