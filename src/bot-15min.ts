/**
 * Polymarket Bitcoin Up/Down 15-Minute Trading Bot
 *
 * Strategy:
 * - Buy UP if price < 50¢
 * - Martingale betting: Win = reset to initial, Loss = double previous bet
 */

import axios, { AxiosInstance } from "axios";
import { config, validateConfig } from "./config.js";
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import type {
    PolymarketMarket,
    TicketPrices,
    ClobMarketResponse,
} from "./types/polymarket.js";

export class PolymarketBot15Min {
    protected privateKey: string;
    protected checkInterval: number;
    protected investmentAmount: number;
    protected initialAmount: number;
    protected currentBetAmount: number;
    protected http: AxiosInstance;
    protected interval?: NodeJS.Timeout;
    protected client?: ClobClient;
    protected signatureType: number;
    protected funderAddress?: string;
    protected orderLock: boolean;
    protected processedMarkets: Set<string>;
    protected trackedMarkets: Map<string, { conditionId: string; side: "UP" | "DOWN" }>;
    protected tradingSide: "UP" | "DOWN" = "UP";

    constructor() {
        const errors = validateConfig();
        if (errors.length) {
            console.warn("⚠️ Configuration warnings:");
            errors.forEach((e) => console.warn(`   - ${e}`));
        }

        this.privateKey = config.api.privateKey;
        this.checkInterval = config.bot.checkInterval;
        this.initialAmount = config.bot.investmentAmount;
        this.currentBetAmount = config.bot.investmentAmount;
        this.investmentAmount = config.bot.investmentAmount;
        
        // Safety: Reset if current bet amount is unreasonably high (likely from previous run)
        if (this.currentBetAmount > this.initialAmount * 100) {
            console.warn(`⚠️ Current bet amount ($${this.currentBetAmount}) is too high, resetting to initial ($${this.initialAmount})`);
            this.currentBetAmount = this.initialAmount;
        }
        
        this.signatureType = parseInt(process.env.SIGNATURE_TYPE || "1");
        this.funderAddress = process.env.FUNDER_ADDRESS;
        this.orderLock = false;
        this.processedMarkets = new Set();
        this.trackedMarkets = new Map();

        this.http = axios.create({
            timeout: 10000,
            headers: { "Content-Type": "application/json" },
        });
    }

    async initialize(): Promise<void> {
        try {
            const HOST = config.api.baseUrl;
            const CHAIN_ID = 137;
            const signer = new Wallet(this.privateKey);
            const funderAddress = this.funderAddress || signer.address;

            console.log("🔧 Config:");
            console.log(`   Signer: ${signer.address}`);
            console.log(`   Funder: ${funderAddress}`);
            console.log(`   Signature Type: ${this.signatureType}`);

            // Initialize client with funder for proxy wallets
            const client = new ClobClient(
                HOST,
                CHAIN_ID,
                signer,
                undefined,
                this.signatureType,
                funderAddress
            );

            console.log("🔑 Deriving API credentials...");
            // Try derive first (for existing keys), fall back to create
            let userApiCreds;
            try {
                userApiCreds = await client.deriveApiKey();
                console.log("   Used existing API key");
            } catch {
                try {
                    userApiCreds = await client.createApiKey();
                    console.log("   Created new API key");
                } catch (e2) {
                    // Last resort: try createOrDerive
                    userApiCreds = await client.createOrDeriveApiKey();
                    console.log("   Used createOrDeriveApiKey");
                }
            }

            this.client = new ClobClient(
                HOST,
                CHAIN_ID,
                signer,
                userApiCreds,
                this.signatureType,
                funderAddress
            );

            this.funderAddress = funderAddress;
            console.log("✅ ClobClient initialized");
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error";
            console.error("❌ Failed to initialize:", errorMessage);
            throw error;
        }
    }

    /**
     * Generate 15-minute BTC Up/Down slug
     * Format: btc-updown-15m-{timestamp}
     * Timestamp is Unix seconds for the START of the 15-min window
     */
    generate15MinSlug(offsetWindows: number = 0): string {
        const now = Date.now();
        const fifteenMin = 15 * 60 * 1000; // 15 minutes in ms
        
        // Get the start of the current 15-min window
        const currentWindowStart = Math.floor(now / fifteenMin) * fifteenMin;
        
        // Add offset for future windows
        const targetWindowStart = currentWindowStart + (offsetWindows * fifteenMin);
        
        // Convert to Unix seconds
        const timestamp = Math.floor(targetWindowStart / 1000);
        
        return `btc-updown-15m-${timestamp}`;
    }

    async findBTC15MinMarkets(): Promise<PolymarketMarket[]> {
        // Generate slugs for current and next few windows
        const slugs: string[] = [];
        for (let i = 0; i < 4; i++) {
            slugs.push(this.generate15MinSlug(i));
        }
        
        console.log(`🔍 Checking: ${slugs[0]}, ${slugs[1]}...`);

        // Method 2: Try slug as query param
        for (const slug of slugs) {
            try {
                const res = await this.http.get(`${config.api.gammaUrl}/events`, {
                    params: { slug }
                });
                if (res.status === 200 && res.data) {
                    const events = Array.isArray(res.data) ? res.data : [res.data];
                    for (const event of events) {
                        const markets = event.markets || [event];
                        const active = markets.filter((m: PolymarketMarket) => !m.closed);
                        if (active.length > 0) {
                            console.log(`   ✅ Found via ?slug=${slug}`);
                            return active;
                        }
                    }
                }
            } catch (e) {
                // Try next method
            }
        }
       
        return [];
    }

    async getTicketPrices(market: PolymarketMarket): Promise<TicketPrices | null> {
        if (!market.clobTokenIds) return null;

        let tokenIds: string[];
        try {
            tokenIds = JSON.parse(market.clobTokenIds);
        } catch {
            return null;
        }

        const [upTokenId, downTokenId] = tokenIds;
        if (!upTokenId || !downTokenId) return null;

        // Get real-time prices from CLOB API
        let upPrice = 0;
        let downPrice = 0;

        try {
            if (this.client) {
                // Get best BUY prices (what we'd pay to buy)
                const upPriceRes = await this.client.getPrice(upTokenId, "BUY");
                const downPriceRes = await this.client.getPrice(downTokenId, "BUY");
                upPrice = Number(upPriceRes?.price || 0);
                downPrice = Number(downPriceRes?.price || 0);
            }
        } catch (e) {
            // Fall back to API prices if CLOB fails
            if (market.outcomePrices) {
                try {
                    const prices = JSON.parse(market.outcomePrices);
                    upPrice = Number(prices[0] || 0);
                    downPrice = Number(prices[1] || 0);
                } catch {}
            }
        }

        if (upPrice === 0 && downPrice === 0) return null;

        return {
            up: upPrice,
            down: downPrice,
            upTokenId,
            downTokenId,
            candidate: upPrice > downPrice ? upPrice : downPrice,
        } as TicketPrices;
    }


    async placeOrder(
        conditionId: string,
        tokenId: string,
        bidPrice: number,
        side: "UP" | "DOWN"
    ): Promise<{ orderID: string; status: string } | null> {
        if (!this.client) {
            console.error("❌ ClobClient not initialized");
            return null;
        }

        try {
            const market: ClobMarketResponse = await this.client.getMarket(conditionId);
            const tickSizeMap: Record<number, "0.1" | "0.01" | "0.001" | "0.0001"> = {
                0.1: "0.1",
                0.01: "0.01",
                0.001: "0.001",
                0.0001: "0.0001",
            };
            const tickSize = tickSizeMap[market.minimum_tick_size] || "0.01";
            
            // Ensure price is a valid number
            const price = Number(bidPrice);
            if (isNaN(price) || price <= 0) {
                console.error(`❌ Invalid price: ${bidPrice}`);
                return null;
            }
            
            const size = Math.floor((this.investmentAmount / price) * 100) / 100; // Round to 2 decimals
            
            console.log(`📝 Placing ${side} order: $${this.investmentAmount} at ${(price * 100).toFixed(1)}¢ (${size.toFixed(2)} shares)`);

            const response = await this.client.createAndPostOrder(
                {
                    tokenID: tokenId,
                    price: price,
                    size: size,
                    side: Side.BUY,
                },
                { tickSize, negRisk: market.neg_risk },
                OrderType.GTC
            );

            console.log(`✅ Order placed: ${response.orderID}`);
            return response;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error";
            console.error(`❌ Failed to place ${side} order:`, errorMessage);
            return null;
        }
    }


    async hasOpenOrderForMarket(conditionId: string): Promise<boolean> {
        if (!this.client) return false;
        try {
            const orders = await this.client.getOpenOrders();
            if (!orders || !Array.isArray(orders)) return false;
            return orders.some(order => order.market === conditionId);
        } catch (e) {
            // Silently fail - assume no existing orders if API call fails
            return false;
        }
    }

    async checkMarketResults(): Promise<void> {
        // Check tracked markets to see if they've closed and determine win/loss
        for (const [marketKey, marketInfo] of this.trackedMarkets.entries()) {
            try {
                if (!this.client) continue;

                // Get market details to check end time
                const markets = await this.findBTC15MinMarkets();
                const marketDetails = markets.find(m => {
                    const details = m.markets?.[0] || m;
                    return details.conditionId === marketInfo.conditionId;
                });

                if (!marketDetails) {
                    continue;
                }

                const details = marketDetails.markets?.[0] || marketDetails;

                // Calculate time left in seconds
                const endDate = details.endDate || details.end_date_iso;
                if (!endDate) {
                    continue;
                }

                const end = new Date(endDate);
                const timeLeftSeconds = (end.getTime() - Date.now()) / 1000;
                
                // Only check if market has ended (time left <= 1 second)
                if (timeLeftSeconds > 1) {
                    continue;
                }
                
                // Remove from tracked markets IMMEDIATELY to prevent double processing
                this.trackedMarkets.delete(marketKey);
                
                // Market has ended, get current UP price to determine win/loss
                const prices = await this.getTicketPrices(details);
                if (!prices) {
                    console.log(`⚠️ Could not get prices for market ${marketInfo.conditionId.slice(0, 8)}`);
                    continue;
                }
                
                const upPrice = prices.up;
                const downPrice = prices.down;
                const upCents = upPrice * 100;
                const downCents = downPrice * 100;
                
                // Win condition based on side:
                // - If we bet UP: win if UP price >= 99¢
                // - If we bet DOWN: win if DOWN price >= 99¢
                let weWon: boolean;
                if (marketInfo.side === "UP") {
                    weWon = upPrice >= 0.99;
                } else {
                    weWon = downPrice >= 0.99;
                }

                console.log(`📊 Market ${marketInfo.conditionId.slice(0, 8)} ended:`);
                console.log(`   Time left: ${timeLeftSeconds.toFixed(1)} seconds`);
                console.log(`   UP price: ${upCents.toFixed(2)}¢ | DOWN price: ${downCents.toFixed(2)}¢`);
                console.log(`   We bet: ${marketInfo.side}, Result: ${weWon ? "WIN" : "LOSS"}`);
                console.log(`   Current bet amount before update: $${this.currentBetAmount}`);

                // Update bet amount based on result
                if (weWon) {
                    // Win: reset to initial amount (NEVER change trading side on win)
                    this.currentBetAmount = this.initialAmount;
                    console.log(`✅ Win! Next bet: $${this.currentBetAmount} (reset to initial), trading side remains: ${this.tradingSide}`);
                } else {
                    // Loss: double the current bet amount (exactly 2x, not 4x)
                    const previousBet = this.currentBetAmount;
                    
                    // Safety mechanism: If we've lost 4 times in a row (bet = 16 * initial),
                    // on the 5th loss, reset to initial and flip trading side
                    const expectedFifthLossBet = 16 * this.initialAmount;
                    const isFifthConsecutiveLoss = Math.abs(previousBet - expectedFifthLossBet) < 0.01; // Use tolerance for floating point comparison
                    
                    console.log(`🔍 Loss check: previousBet=$${previousBet}, initialAmount=$${this.initialAmount}, expectedFifthLossBet=$${expectedFifthLossBet}, isFifthConsecutiveLoss=${isFifthConsecutiveLoss}`);
                    
                    if (isFifthConsecutiveLoss) {
                        // 5th consecutive loss: Reset bet and flip trading side
                        const oldSide = this.tradingSide;
                        this.currentBetAmount = this.initialAmount;
                        this.tradingSide = this.tradingSide === "UP" ? "DOWN" : "UP";
                        console.log(`🔄 5th consecutive loss detected! Resetting bet to $${this.currentBetAmount} and switching trading side from ${oldSide} to ${this.tradingSide}`);
                    } else {
                        // Normal loss: double the bet (NEVER change trading side on normal loss)
                        this.currentBetAmount = 2 * this.currentBetAmount;
                        console.log(`❌ Loss! Previous bet: $${previousBet}, Next bet: $${this.currentBetAmount} (doubled to 2x), trading side remains: ${this.tradingSide}`);
                    }
                }
            } catch (e) {
                const errorMsg = e instanceof Error ? e.message : String(e);
                console.log(`⚠️ Error checking market ${marketInfo.conditionId.slice(0, 8)}: ${errorMsg}`);
            }
        }
    }

    async checkMarket(market: PolymarketMarket): Promise<void> {
        const details = market.markets?.[0] || market;
        const conditionId = details.conditionId;
        if (!conditionId) return;

        // Skip if already processed in this tick
        if (this.processedMarkets.has(conditionId)) {
            return;
        }

        // Skip if order is being placed (lock)
        if (this.orderLock) {
            return;
        }

        // Skip if we already have an order in this market (tracked or open)
        if (this.trackedMarkets.has(conditionId)) {
            console.log(`⏸️ Already have order in market ${conditionId.slice(0, 8)}... (tracked)`);
            this.processedMarkets.add(conditionId);
            return;
        }

        // Check Polymarket API for existing open orders in this market
        const hasExistingOrder = await this.hasOpenOrderForMarket(conditionId);
        if (hasExistingOrder) {
            console.log(`⏸️ Already have open order in market ${conditionId.slice(0, 8)}...`);
            this.processedMarkets.add(conditionId);
            return;
        }

        const prices = await this.getTicketPrices(details);
        if (!prices) return;

        const upCents = prices.up * 100;
        const downCents = prices.down * 100;

        console.log(`💰 UP: ${upCents.toFixed(1)}¢ | DOWN: ${downCents.toFixed(1)}¢`);
        console.log(`💵 Current bet amount: $${this.currentBetAmount} (Initial: $${this.initialAmount})`);
        console.log(`📊 Trading side: ${this.tradingSide} (type: ${typeof this.tradingSide})`);

        let tokenId: string;
        let side: "UP" | "DOWN";
        let bidPrice: number;
        let priceCents: number;

        // Strategy: Buy based on selected side
        // Normalize trading side to uppercase for comparison
        const currentSide = (this.tradingSide || "UP").toUpperCase() as "UP" | "DOWN";
        console.log(`🔍 Trading side check: "${currentSide}" (stored value: "${this.tradingSide}")`);
        
        if (currentSide === "DOWN") {
            // Buy DOWN if down price < 50¢
            console.log(`📉 DOWN mode: Checking DOWN price ${downCents.toFixed(1)}¢`);
            if (downCents >= 50) {
                console.log(`⏳ DOWN price ${downCents.toFixed(1)}¢ >= 50¢, skipping`);
                return;
            }
            tokenId = prices.downTokenId;
            side = "DOWN";
            bidPrice = prices.down;
            priceCents = downCents;
            console.log(`🎯 DOWN price ${downCents.toFixed(1)}¢ < 50¢ → Buying DOWN at ${(bidPrice * 100).toFixed(1)}¢`);
        } else {
            // Default to UP if not explicitly DOWN
            console.log(`📈 UP mode: Checking UP price ${upCents.toFixed(1)}¢`);
            if (upCents >= 50) {
                console.log(`⏳ UP price ${upCents.toFixed(1)}¢ >= 50¢, skipping`);
                return;
            }
            tokenId = prices.upTokenId;
            side = "UP";
            bidPrice = prices.up;
            priceCents = upCents;
            console.log(`🎯 UP price ${upCents.toFixed(1)}¢ < 50¢ → Buying UP at ${(bidPrice * 100).toFixed(1)}¢`);
        }

        // Capture current bet amount NOW - this is the amount we'll use for this order
        const betAmountForThisOrder = this.currentBetAmount;

        // Acquire lock and mark as processed atomically
        if (this.orderLock) {
            return;
        }
        this.orderLock = true;
        this.processedMarkets.add(conditionId);
        
        try {
            // Final check for existing orders (in case one was placed between checks)
            if (this.trackedMarkets.has(conditionId)) {
                console.log(`⏸️ Market ${conditionId.slice(0, 8)} already tracked, skipping`);
                return;
            }
            
            const hasExistingOrderNow = await this.hasOpenOrderForMarket(conditionId);
            if (hasExistingOrderNow) {
                console.log(`⏸️ Order already exists in market ${conditionId.slice(0, 8)}...`);
                return;
            }
            
            // Mark market as tracked IMMEDIATELY to prevent duplicate orders
            // This happens before placing the order to prevent race conditions
            this.trackedMarkets.set(conditionId, {
                conditionId,
                side
            });
            
            // Use the captured bet amount for this order
            this.investmentAmount = betAmountForThisOrder;
            
            console.log(`💰 Placing order with bet amount: $${betAmountForThisOrder}`);
            
            const orderResult = await this.placeOrder(conditionId, tokenId, bidPrice, side);
            
            // If order failed, remove from tracked markets so we can retry
            if (!orderResult?.orderID) {
                this.trackedMarkets.delete(conditionId);
                console.log(`⚠️ Order failed, removed from tracking for retry`);
            } else {
                console.log(`✅ Order placed successfully with amount: $${betAmountForThisOrder}`);
            }
        } finally {
            this.orderLock = false;
        }
    }

    async tick(): Promise<void> {
        try {
            // Check market results to update win/loss state and bet amounts
            await this.checkMarketResults();
            
            // Clear processed markets at the start of each tick
            this.processedMarkets.clear();
            
            const markets = await this.findBTC15MinMarkets();
            if (markets.length === 0) {
                console.log(`⏳ No 15-min markets found`);
            } else {
                console.log(`📊 Found ${markets.length} market(s)`);
            }
            await Promise.allSettled(markets.map((m) => this.checkMarket(m)));
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : "Unknown error";
            console.error("Tick error:", errorMessage);
        }
    }

    async start(): Promise<void> {
        console.log("🚀 Starting Polymarket BTC Up/Down 15-MIN Bot");
        console.log(`📊 Trading Side: ${this.tradingSide}`);
        console.log(`Buy Strategy: Buy ${this.tradingSide} if ${this.tradingSide} price < 50¢`);
        console.log(`Betting Strategy: Martingale - Win: reset to initial, Loss: double previous bet`);
        console.log(`Initial Investment: $${this.initialAmount}`);
        console.log(`Current Bet Amount: $${this.currentBetAmount}`);
        console.log("-".repeat(50));

        await this.initialize();
        
        // Log trading side one more time after initialization to verify it's still set
        console.log(`📊 Trading side after initialization: ${this.tradingSide}`);

        this.tick();
        this.interval = setInterval(() => this.tick(), this.checkInterval);
    }

    stop(): void {
        if (this.interval) clearInterval(this.interval);
        console.log("🛑 Bot stopped");
    }

    setInitialAmount(amount: number): void {
        if (amount <= 0) {
            console.warn(`⚠️ Invalid initial amount: ${amount}, keeping current: ${this.initialAmount}`);
            return;
        }
        const oldInitial = this.initialAmount;
        this.initialAmount = amount;
        this.investmentAmount = amount;
        
        // If bot is not running, also reset current bet amount to new initial
        // If bot is running, keep current bet amount but update initial for future resets
        if (!this.interval) {
            this.currentBetAmount = amount;
            console.log(`✅ Initial amount updated: $${oldInitial} → $${amount}, current bet reset to $${amount}`);
        } else {
            console.log(`✅ Initial amount updated: $${oldInitial} → $${amount} (current bet remains at $${this.currentBetAmount})`);
        }
    }
}

// Auto-start code removed - bot is now controlled via server.ts
// To run bot directly, use: npm run start:15min (which uses a separate entry point)
