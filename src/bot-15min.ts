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
    protected waitingFor5Consecutive: boolean = false;
    protected consecutiveCandlesCount: number = 5;

    constructor(options?: {
        privateKey?: string;
        checkInterval?: number;
        initialAmount?: number;
        funderAddress?: string;
        consecutiveCandlesCount?: number;
    }) {
        const errors = validateConfig();
        if (errors.length) {
            console.warn("⚠️ Configuration warnings:");
            errors.forEach((e) => console.warn(`   - ${e}`));
        }

        // Use provided options or fall back to config/env values
        this.privateKey = options?.privateKey || config.api.privateKey;
        this.checkInterval = options?.checkInterval ?? config.bot.checkInterval;
        this.initialAmount = options?.initialAmount ?? config.bot.investmentAmount;
        this.currentBetAmount = this.initialAmount;
        this.investmentAmount = this.initialAmount;
        
        // Safety: Reset if current bet amount is unreasonably high (likely from previous run)
        if (this.currentBetAmount > this.initialAmount * 100) {
            console.warn(`⚠️ Current bet amount ($${this.currentBetAmount}) is too high, resetting to initial ($${this.initialAmount})`);
            this.currentBetAmount = this.initialAmount;
        }
        
        this.signatureType = parseInt(process.env.SIGNATURE_TYPE || "1");
        this.funderAddress = options?.funderAddress || process.env.FUNDER_ADDRESS;
        this.consecutiveCandlesCount = options?.consecutiveCandlesCount ?? parseInt(process.env.CONSECUTIVE_CANDLES_COUNT || "5", 10);
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

    async findBTC15MinMarkets(): Promise<{ current: PolymarketMarket | null; next: PolymarketMarket | null }> {
        const currentSlug = this.generate15MinSlug(0);
        const nextSlug = this.generate15MinSlug(1);
        
        console.log(`🔍 Checking current: ${currentSlug}, next: ${nextSlug}...`);

        let currentMarket: PolymarketMarket | null = null;
        let nextMarket: PolymarketMarket | null = null;

        // Fetch current market
        try {
            const currentRes = await this.http.get(`${config.api.gammaUrl}/events`, {
                params: { slug: currentSlug }
            });
            if (currentRes.status === 200 && currentRes.data) {
                const events = Array.isArray(currentRes.data) ? currentRes.data : [currentRes.data];
                for (const event of events) {
                    const markets = event.markets || [event];
                    const active = markets.filter((m: PolymarketMarket) => !m.closed);
                    if (active.length > 0) {
                        currentMarket = active[0];
                        break;
                    }
                }
            }
        } catch (e) {
            console.log(`⚠️ Failed to fetch current market: ${e}`);
        }

        // Fetch next market
        try {
            const nextRes = await this.http.get(`${config.api.gammaUrl}/events`, {
                params: { slug: nextSlug }
            });
            if (nextRes.status === 200 && nextRes.data) {
                const events = Array.isArray(nextRes.data) ? nextRes.data : [nextRes.data];
                for (const event of events) {
                    const markets = event.markets || [event];
                    const active = markets.filter((m: PolymarketMarket) => !m.closed);
                    if (active.length > 0) {
                        nextMarket = active[0];
                        break;
                    }
                }
            }
        } catch (e) {
            console.log(`⚠️ Failed to fetch next market: ${e}`);
        }

        return { current: currentMarket, next: nextMarket };
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
    
    async getLastNCandles(
        count: number = this.consecutiveCandlesCount
        ): Promise<Array<{ time: string; low: number; high: number; open: number; close: number; volume: number }> | null> {
        const BINANCE_URL = "https://api.binance.com/api/v3/klines";
        const SYMBOL = "BTCUSDT";
        const INTERVAL = "15m";

        try {
            const url = `${BINANCE_URL}?symbol=${SYMBOL}&interval=${INTERVAL}&limit=${count}`;
            const res = await this.http.get<any[]>(url);
            const data = res.data;

            // Binance kline format:
            // [
            //   0 open time,
            //   1 open,
            //   2 high,
            //   3 low,
            //   4 close,
            //   5 volume,
            //   6 close time,
            //   ...
            // ]

            const candles = data.map((kline: any[]) => ({
            time: new Date(kline[0]).toISOString(),
            open: parseFloat(kline[1]),
            high: parseFloat(kline[2]),
            low: parseFloat(kline[3]),
            close: parseFloat(kline[4]),
            volume: parseFloat(kline[5]),
            }));

            console.log(`📊 Last ${count} candles:`, candles);
            return candles;
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            console.log(`⚠️ Error fetching candles: ${errorMsg}`);
            return null;
        }
    }

    setConsecutiveCandlesCount(count: number): void {
        if (count < 1 || count > 20) {
            console.warn(`⚠️ Invalid consecutive candles count: ${count}. Must be between 1 and 20. Keeping current: ${this.consecutiveCandlesCount}`);
            return;
        }
        this.consecutiveCandlesCount = count;
        console.log(`✅ Consecutive candles count set to: ${count}`);
    }

    async checkMarketResults(): Promise<void> {
        if (!this.client) return;
        console.log("2222222222222222222222222", {
            privateKey: this.privateKey,
            checkInterval: this.checkInterval,
            investmentAmount: this.investmentAmount,
            initialAmount: this.initialAmount,
            currentBetAmount: this.currentBetAmount,
            funderAddress: this.funderAddress,
            consecutiveCandlesCount: this.consecutiveCandlesCount,
            tradedMarkets: this.trackedMarkets
        })

        // Step 1: Check tracked markets to see if they've closed and determine win/loss
        for (const [marketKey, marketInfo] of this.trackedMarkets.entries()) {
            try {
                // Get market details to check end time
                const { current, next } = await this.findBTC15MinMarkets();
                const markets = [current, next].filter(m => m !== null) as PolymarketMarket[];
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
                if (timeLeftSeconds > 5) {
                    continue;
                }
                
                // Remove from tracked markets IMMEDIATELY to prevent double processing
                this.trackedMarkets.delete(marketKey);
                
                // Market has ended, get current prices to determine win/loss
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

                // Step 2: Update bet amount based on result
                if (weWon) {
                    // Win: reset to initial amount and wait for N consecutive candles
                    this.currentBetAmount = this.initialAmount;
                    this.investmentAmount = this.initialAmount;
                    this.waitingFor5Consecutive = true;
                    console.log(`✅ Win! Reset bet to $${this.currentBetAmount} (initial). Waiting for ${this.consecutiveCandlesCount} consecutive same-color candles before next bet.`);
                } else {
                    // Loss: double the current bet amount (2x)
                    const previousBet = this.currentBetAmount;
                    this.currentBetAmount = 2 * this.currentBetAmount;
                    this.investmentAmount = this.currentBetAmount;
                    console.log(`❌ Loss! Previous bet: $${previousBet}, Next bet: $${this.currentBetAmount} (doubled to 2x)`);
                }
            } catch (e) {
                const errorMsg = e instanceof Error ? e.message : String(e);
                console.log(`⚠️ Error checking market ${marketInfo.conditionId.slice(0, 8)}: ${errorMsg}`);
            }
        }

        // Step 3: Check for N consecutive same-color candles and place order to opposite color
        try {
            const candles = await this.getLastNCandles(this.consecutiveCandlesCount);
            if (!candles || candles.length !== this.consecutiveCandlesCount) {
                return;
            }

            // Determine color of each candle: green/UP if close > open, red/DOWN if close < open
            const candleColors = candles.map(candle => candle.close > candle.open ? "UP" : "DOWN");
            console.log(44444444444444, candleColors)
            const allSameColor = candleColors.every(color => color === candleColors[0]);
            
            if (allSameColor) {
                const dominantColor = candleColors[0];
                const oppositeColor = dominantColor === "UP" ? "DOWN" : "UP";
                
                // If we're waiting for N consecutive candles after a win, clear the flag
                if (this.waitingFor5Consecutive) {
                    this.waitingFor5Consecutive = false;
                    console.log(`✅ ${this.consecutiveCandlesCount} consecutive ${dominantColor} candles detected after win. Ready to place next bet.`);
                }

                // Place order to opposite color (we only get here if we have N consecutive candles)
                // If we were waiting, we've now cleared the flag, so proceed with order
                console.log(`🔄 All ${this.consecutiveCandlesCount} candles are ${dominantColor}, placing order to ${oppositeColor}`);
                
                // Find available market (prefer current, fallback to next)
                const { current, next } = await this.findBTC15MinMarkets();
                const market = current || next;
                console.log({current, next})
                if (!market) {
                    console.log(`⏳ No 15-min markets found for placing order`);
                    return;
                }

                console.log(`📊 Using ${current ? 'current' : 'next'} market:`, JSON.stringify(market));
                const details = market.markets?.[0] || market;
                const conditionId = current?.conditionId;

                if (!conditionId) {
                    console.log(`⚠️ No conditionId found for market`);
                    return;
                }

                // Skip if we already have an order in this market
                if (this.trackedMarkets.has(conditionId)) {
                    console.log(`⏸️ Already have order in market ${conditionId.slice(0, 8)}...`);
                    return;
                }

                const hasExistingOrder = await this.hasOpenOrderForMarket(conditionId);
                if (hasExistingOrder) {
                    console.log(`⏸️ Already have open order in market ${conditionId.slice(0, 8)}...`);
                    return;
                }

                // Get prices
                const prices = await this.getTicketPrices(next!);
                if (!prices) {
                    console.log(`⚠️ Could not get prices for market ${conditionId.slice(0, 8)}`);
                    return;
                }

                // Determine token and price based on opposite color
                let tokenId: string;
                let bidPrice: number;
                let side: "UP" | "DOWN" = oppositeColor;

                if (oppositeColor === "UP") {
                    tokenId = prices.upTokenId;
                    bidPrice = prices.up;
                } else {
                    tokenId = prices.downTokenId;
                    bidPrice = prices.down;
                }

                // Acquire lock before placing order
                if (this.orderLock) {
                    console.log(`⏸️ Order lock active, skipping`);
                    return;
                }

                this.orderLock = true;
                try {
                    // Final check for existing orders
                    if (this.trackedMarkets.has(conditionId)) {
                        console.log(`⏸️ Market ${conditionId.slice(0, 8)} already tracked, skipping`);
                        return;
                    }

                    const hasExistingOrderNow = await this.hasOpenOrderForMarket(conditionId);
                    if (hasExistingOrderNow) {
                        console.log(`⏸️ Order already exists in market ${conditionId.slice(0, 8)}...`);
                        return;
                    }

                    // Mark market as tracked
                    this.trackedMarkets.set(conditionId, {
                        conditionId,
                        side
                    });

                    // Place order with current bet amount
                    console.log(`💰 Placing ${side} order with bet amount: $${this.currentBetAmount}`);
                    const orderResult = await this.placeOrder(next?.conditionId!, tokenId, bidPrice, side);

                    if (!orderResult?.orderID) {
                        this.trackedMarkets.delete(conditionId);
                        console.log(`⚠️ Order failed, removed from tracking`);
                    } else {
                        console.log(`✅ Order placed successfully: ${side} at ${(bidPrice * 100).toFixed(1)}¢ with $${this.currentBetAmount}`);
                    }
                } finally {
                    this.orderLock = false;
                }
            } else {
                if (this.waitingFor5Consecutive) {
                    console.log(`⏳ Waiting for ${this.consecutiveCandlesCount} consecutive same-color candles. Current candles are mixed.`);
                }
            }
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            console.log(`⚠️ Error checking candles: ${errorMsg}`);
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
            // this.processedMarkets.clear();
            
            // const markets = await this.findBTC15MinMarkets();
            // if (markets.length === 0) {
            //     console.log(`⏳ No 15-min markets found`);
            // } else {
            //     console.log(`📊 Found ${markets.length} market(s)`);
            // }
            // await Promise.allSettled(markets.map((m) => this.checkMarket(m)));
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
