import express, { Request, Response } from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { PolymarketBot15Min } from './bot-15min-instance.js';
import { validateConfig } from './utils/index.js';

const app = express();
app.use(cors());
app.use(express.json());

// Store bot instance
let botInstance: PolymarketBot15Min | null = null;
let cronJob: ReturnType<typeof cron.schedule> | null = null;

// API Routes
app.get('/api/status', (req: Request, res: Response) => {
    if (!botInstance) {
        return res.json({
            running: false,
            currentBetAmount: 0,
            initialAmount: 0,
            winCount: 0,
            lossCount: 0,
            lastResult: null,
            lastMarketId: null,
            history: [],
            trackedMarketsCount: 0,
            tradingSide: 'UP',
            consecutiveCandlesCount: 5,
        });
    }
    const status = botInstance.getStatus();
    console.log(`📡 /api/status called: winCount=${status.winCount}, lossCount=${status.lossCount}, historyLength=${status.history?.length || 0}`);
    res.json(status);
});

app.get('/api/config', (req: Request, res: Response) => {
    if (botInstance) {
        const config = botInstance.getConfig();
        const status = botInstance.getStatus();
        return res.json({
            ...config,
            tradingSide: status.tradingSide || 'UP',
            consecutiveCandlesCount: status.consecutiveCandlesCount || 5,
        });
    }
    // Return config from environment variables if bot not initialized
    res.json({
        privateKey: process.env.PRIVATE_KEY ? `${process.env.PRIVATE_KEY.slice(0, 6)}...${process.env.PRIVATE_KEY.slice(-4)}` : '',
        investmentAmount: parseFloat(process.env.INVESTMENT_AMOUNT || '10'),
        checkInterval: parseInt(process.env.CHECK_INTERVAL || '5000', 10),
        signatureType: parseInt(process.env.SIGNATURE_TYPE || '1', 10),
        funderAddress: process.env.FUNDER_ADDRESS || '',
        tradingSide: 'UP',
        consecutiveCandlesCount: parseInt(process.env.CONSECUTIVE_CANDLES_COUNT || '5', 10),
    });
});

app.post('/api/config', async (req: Request, res: Response) => {
    try {
        const { privateKey, investmentAmount, checkInterval, signatureType, funderAddress, tradingSide, consecutiveCandlesCount } = req.body;
        
        // Update environment variables
        if (privateKey !== undefined) process.env.PRIVATE_KEY = privateKey;
        if (investmentAmount !== undefined) process.env.INVESTMENT_AMOUNT = String(investmentAmount);
        if (checkInterval !== undefined) process.env.CHECK_INTERVAL = String(checkInterval);
        if (signatureType !== undefined) process.env.SIGNATURE_TYPE = String(signatureType);
        if (funderAddress !== undefined) process.env.FUNDER_ADDRESS = funderAddress;
        if (consecutiveCandlesCount !== undefined) process.env.CONSECUTIVE_CANDLES_COUNT = String(consecutiveCandlesCount);
        
        // Update trading side if bot is running
        if (botInstance && tradingSide !== undefined) {
            console.log(`🔄 Updating trading side to: ${tradingSide}`);
            botInstance.setTradingSide(tradingSide);
            console.log(`✅ Trading side updated. Current side: ${botInstance.getStatus().tradingSide}`);
        }
        
        // Update consecutive candles count if bot is running
        if (botInstance && consecutiveCandlesCount !== undefined) {
            console.log(`🔄 Updating consecutive candles count to: ${consecutiveCandlesCount}`);
            botInstance.setConsecutiveCandlesCount(consecutiveCandlesCount);
            console.log(`✅ Consecutive candles count updated. Current count: ${botInstance.getStatus().consecutiveCandlesCount}`);
        }
        
        res.json({ success: true, message: 'Config updated' });
    } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
});

app.post('/api/start', async (req: Request, res: Response) => {
    try {
        if (botInstance) {
            return res.json({ error: 'Bot is already running' });
        }
        
        // Extract values from request body
        const { 
            privateKey, 
            investmentAmount, 
            checkInterval = 5000, 
            funderAddress, 
            consecutiveCandlesCount = 5,
        } = req.body;
        
        console.log(`🚀 Starting bot with request body:`, JSON.stringify(req.body));
        

        const { result, errors } = validateConfig({
            privateKey,
            investmentAmount,
            checkInterval,
            funderAddress,
            consecutiveCandlesCount,
        });
        if (!result) {
            return res.status(400).json({ error: errors.join(', ') });
        }
        
        // Create bot instance with constructor parameters
        // Set checkInterval to 0 when using cron (cron will handle scheduling)
        botInstance = new PolymarketBot15Min({
            privateKey: privateKey,
            checkInterval: checkInterval, // Set to 0 for cron-based execution
            initialAmount: investmentAmount,
            funderAddress: funderAddress,
            consecutiveCandlesCount: consecutiveCandlesCount,
        });
        
        await botInstance.start();
        
        // // Set up cron job to run at 14, 29, 44, 59 minutes past every hour
        // // Cron expression: "14,29,44,59 * * * *" means: at minutes 14, 29, 44, 59 of every hour
        // if (cronJob) {
        //     cronJob.stop();
        // }
        
        // cronJob = cron.schedule('14,29,44,59 * * * *', async () => {
        //     console.log(`⏰ Cron job triggered at ${new Date().toISOString()}`);
        //     if (botInstance) {
        //         try {
        //             await botInstance.tick();
        //         } catch (error) {
        //             console.error('❌ Error in cron job tick:', error);
        //         }
        //     }
        // });
        
        console.log('✅ Cron job scheduled to run at 14, 29, 44, 59 minutes past every hour');
        res.json({ success: true, message: 'Bot started with cron schedule (14, 29, 44, 59 minutes past every hour)' });
    } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
});

app.post('/api/stop', (req: Request, res: Response) => {
    try {
        if (!botInstance) {
            return res.json({ error: 'Bot is not running' });
        }
        
        // Stop cron job
        if (cronJob) {
            cronJob.stop();
            cronJob = null;
            console.log('🛑 Cron job stopped');
        }
        
        botInstance.stop();
        botInstance = null;
        res.json({ success: true, message: 'Bot stopped' });
    } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
});

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
    app.use(express.static('dist'));
}

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📊 API available at http://localhost:${PORT}/api`);
});
