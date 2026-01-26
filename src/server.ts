import express, { Request, Response } from 'express';
import cors from 'cors';
import { PolymarketBot15Min } from './bot-15min-instance.js';

const app = express();
app.use(cors());
app.use(express.json());

// Store bot instance
let botInstance: PolymarketBot15Min | null = null;

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
    });
});

app.post('/api/config', async (req: Request, res: Response) => {
    try {
        const { privateKey, investmentAmount, checkInterval, signatureType, funderAddress, tradingSide } = req.body;
        
        // Update environment variables
        if (privateKey !== undefined) process.env.PRIVATE_KEY = privateKey;
        if (investmentAmount !== undefined) process.env.INVESTMENT_AMOUNT = String(investmentAmount);
        if (checkInterval !== undefined) process.env.CHECK_INTERVAL = String(checkInterval);
        if (signatureType !== undefined) process.env.SIGNATURE_TYPE = String(signatureType);
        if (funderAddress !== undefined) process.env.FUNDER_ADDRESS = funderAddress;
        
        // Update trading side if bot is running
        if (botInstance && tradingSide !== undefined) {
            console.log(`🔄 Updating trading side to: ${tradingSide}`);
            botInstance.setTradingSide(tradingSide);
            console.log(`✅ Trading side updated. Current side: ${botInstance.getStatus().tradingSide}`);
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
        
        // Validate required fields
        const errors: string[] = [];
        if (!process.env.PRIVATE_KEY) {
            errors.push('Private Key is required');
        }
        if (!process.env.INVESTMENT_AMOUNT || parseFloat(process.env.INVESTMENT_AMOUNT) <= 0) {
            errors.push('Investment Amount must be greater than 0');
        }
        if (!process.env.CHECK_INTERVAL || parseInt(process.env.CHECK_INTERVAL) <= 0) {
            errors.push('Check Interval must be greater than 0');
        }
        
        if (errors.length > 0) {
            return res.status(400).json({ error: errors.join(', ') });
        }
        
        botInstance = new PolymarketBot15Min();
        
        // Set trading side if provided
        const { tradingSide } = req.body;
        console.log(`🚀 Starting bot with trading side from request: ${tradingSide || 'undefined'}`);
        console.log(`🚀 Request body:`, JSON.stringify(req.body));
        
        if (tradingSide) {
            console.log(`🔄 Setting trading side to: ${tradingSide}`);
            botInstance.setTradingSide(tradingSide);
            // Verify it was set
            const verifyStatus = botInstance.getStatus();
            console.log(`✅ Trading side verified after set: ${verifyStatus.tradingSide}`);
        } else {
            console.log(`⚠️ No trading side provided in request body, using default: UP`);
        }
        
        // Verify trading side is set correctly before starting
        const statusBeforeStart = botInstance.getStatus();
        console.log(`📊 Final bot trading side before start: ${statusBeforeStart.tradingSide}`);
        console.log(`📊 Bot instance tradingSide property: ${(botInstance as any).tradingSide}`);
        
        await botInstance.start();
        res.json({ success: true, message: 'Bot started' });
    } catch (error) {
        res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
    }
});

app.post('/api/stop', (req: Request, res: Response) => {
    try {
        if (!botInstance) {
            return res.json({ error: 'Bot is not running' });
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
