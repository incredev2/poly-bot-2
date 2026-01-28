// Export the bot class and add status tracking
import { PolymarketBot15Min as BotClass } from './bot-15min.js';

export class PolymarketBot15Min extends BotClass {
    private winCount: number = 0;
    private lossCount: number = 0;
    private lastResult: "win" | "loss" | null = null;
    private lastMarketId: string | null = null;
    private isRunning: boolean = false;
    private history: Array<{ marketId: string; result: "win" | "loss"; betAmount: number; side: "UP" | "DOWN"; timestamp: string }> = [];
    private previousBetAmount: number = 0;

    constructor(options?: {
        privateKey: string;
        checkInterval: number;
        initialAmount: number;
        funderAddress: string;
        consecutiveCandlesCount: number;
    }) {
        super(options);
        this.previousBetAmount = this.currentBetAmount;
    }

    async start(): Promise<void> {
        console.log(`🎯 BotInstance.start() called, tradingSide: ${this.tradingSide}`);
        this.isRunning = true;
        await super.start();
        console.log(`🎯 BotInstance.start() completed, tradingSide: ${this.tradingSide}`);
    }

    stop(): void {
        this.isRunning = false;
        super.stop();
    }

    getStatus() {
        const status = {
            running: this.isRunning,
            currentBetAmount: this.currentBetAmount,
            initialAmount: this.initialAmount,
            winCount: this.winCount,
            lossCount: this.lossCount,
            lastResult: this.lastResult,
            lastMarketId: this.lastMarketId,
            history: this.history, // Last 10 results
            trackedMarketsCount: this.trackedMarkets?.size || 0,
            tradingSide: this.tradingSide || "UP",
            consecutiveCandlesCount: this.consecutiveCandlesCount,
        };
        console.log('getStatus called, history length:', this.history.length, 'returning:', status.history.length);
        return status;
    }

    setTradingSide(side: "UP" | "DOWN") {
        console.log(`🔄 setTradingSide called with: ${side} (type: ${typeof side})`);
        this.tradingSide = side.toUpperCase() as "UP" | "DOWN";
        console.log(`✅ Trading side set to: ${this.tradingSide}`);
    }

    getConfig() {
        return {
            privateKey: this.privateKey ? `${this.privateKey.slice(0, 6)}...${this.privateKey.slice(-4)}` : '',
            investmentAmount: this.initialAmount,
            checkInterval: this.checkInterval,
            signatureType: this.signatureType,
            funderAddress: this.funderAddress || '',
            consecutiveCandlesCount: this.consecutiveCandlesCount,
        };
    }

    setConsecutiveCandlesCount(count: number): void {
        super.setConsecutiveCandlesCount(count);
    }

    // Override checkMarketResults to track wins/losses
    // async checkMarketResults(): Promise<void> {
    //     const trackedMarkets = this.trackedMarkets;
    //     const previousBet = this.currentBetAmount;
    //     const trackedMarketsBefore = new Map(trackedMarkets);
        
    //     console.log(`🔍 checkMarketResults: Previous bet: $${previousBet}, Tracked markets: ${trackedMarkets.size}`);
        
    //     // Call parent method
    //     await super.checkMarketResults();
        
    //     const currentBet = this.currentBetAmount;
    //     const trackedMarketsAfter = this.trackedMarkets;
        
    //     console.log(`🔍 checkMarketResults: Current bet: $${currentBet}, Tracked markets after: ${trackedMarketsAfter.size}`);
        
    //     // Find which market(s) were removed (processed)
    //     const processedMarkets = Array.from(trackedMarketsBefore.keys()).filter(
    //         key => !trackedMarketsAfter.has(key)
    //     );
        
    //     console.log(`🔍 Processed markets count: ${processedMarkets.length}`);
        
    //     // Only track history if bet amount changed, which indicates a real market resolution
    //     // If bet amount didn't change, the market was likely removed due to order failure, not resolution
    //     if (currentBet !== previousBet && processedMarkets.length > 0) {
    //         // Process each market that was removed AND bet amount changed
    //         for (const processedMarket of processedMarkets) {
    //             // Determine result based on bet amount change:
    //             // - If bet decreased: WIN (reset to initial)
    //             // - If bet increased: LOSS (doubled)
    //             let result: "win" | "loss";
                
    //             if (currentBet < previousBet) {
    //                 // Bet decreased = WIN (reset to initial)
    //                 result = "win";
    //             } else if (currentBet > previousBet) {
    //                 // Bet increased = LOSS (doubled)
    //                 result = "loss";
    //             } else {
    //                 // This shouldn't happen since we're inside the "currentBet !== previousBet" check
    //                 console.log(`⚠️ Unexpected: bet amount didn't change but we're processing market ${processedMarket.slice(0, 8)}`);
    //                 continue; // Skip this market
    //             }
                
    //             console.log(`📊 Processing resolved market ${processedMarket.slice(0, 8)}: Previous bet: $${previousBet}, Current bet: $${currentBet}, Result: ${result}`);
                
    //             if (result === "win") {
    //                 this.winCount++;
    //                 console.log(`✅ Win! Win count: ${this.winCount}`);
    //             } else {
    //                 this.lossCount++;
    //                 console.log(`❌ Loss! Loss count: ${this.lossCount}`);
    //             }
                
    //             this.lastResult = result;
    //             this.lastMarketId = processedMarket;
                
    //             // Get the side from the tracked market info
    //             const marketInfo = trackedMarketsBefore.get(processedMarket);
    //             const side = marketInfo?.side || "UP";
                
    //             // Add to history
    //             const historyEntry = {
    //                 marketId: processedMarket,
    //                 result,
    //                 betAmount: previousBet,
    //                 side,
    //                 timestamp: new Date().toISOString(),
    //             };
    //             this.history.push(historyEntry);
    //             console.log('✅ Added to history:', historyEntry);
    //             console.log('📊 Total history entries:', this.history.length);
    //         }
            
    //         // Keep only last 50 entries
    //         if (this.history.length > 50) {
    //             this.history = this.history.slice(-50);
    //         }
    //     } else {
    //         if (processedMarkets.length > 0 && currentBet === previousBet) {
    //             console.log(`⚠️ Market(s) removed but bet amount unchanged (${previousBet}) - likely order failure, not market resolution. Skipping history update.`);
    //             console.log(`   Removed markets: ${processedMarkets.map(m => m.slice(0, 8)).join(', ')}`);
    //         } else if (processedMarkets.length === 0) {
    //             console.log(`⚠️ No markets were processed, skipping history update`);
    //         }
    //     }
    // }
}

// Export singleton instance
export const botInstance = new PolymarketBot15Min();
