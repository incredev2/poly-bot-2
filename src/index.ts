/**
 * Polymarket Bitcoin Up/Down Trading Bot
 *
 * Strategy:
 * - If UP price < 50 cents: buy $10 of UP
 * - If DOWN price < (100 - UP_price - 10): buy $10 of DOWN
 */

import axios, { AxiosInstance, AxiosResponse } from "axios";
import { config, validateConfig } from "./config.js";
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import type {
    PolymarketMarket,
    TicketPrices,
    ClobMarketResponse,
} from "./types/polymarket.js";

class PolymarketBot {
    private privateKey: string;
    private checkInterval: number;
    private investmentAmount: number;
    private timeThresholdMinutes: number;
    private isRunning: boolean;
    private http: AxiosInstance;
    private etFormatter: Intl.DateTimeFormat;
    private interval?: NodeJS.Timeout;
    private client?: ClobClient;
    private signatureType: number;
    private funderAddress?: string;
    private orderLock: boolean;

    constructor() {
        const errors = validateConfig();
        if (errors.length) {
            console.warn("⚠️ Configuration warnings:");
            errors.forEach((e) => console.warn(`   - ${e}`));
            console.warn("");
        }

        this.privateKey = config.api.privateKey;
        this.checkInterval = config.bot.checkInterval;
        this.investmentAmount = config.bot.investmentAmount;
        this.timeThresholdMinutes = config.bot.timeThresholdMinutes;
        this.isRunning = false;
        this.signatureType = parseInt(process.env.SIGNATURE_TYPE || "1");
        this.funderAddress = process.env.FUNDER_ADDRESS;
        this.orderLock = false;

        this.http = axios.create({
            timeout: 10000,
            headers: { "Content-Type": "application/json" },
        });

        this.etFormatter = new Intl.DateTimeFormat("en-US", {
            timeZone: "America/New_York",
            month: "long",
            day: "numeric",
            hour: "numeric",
            hour12: true,
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
            console.error("❌ Failed to initialize ClobClient:", errorMessage);
            throw error;
        }
    }

    generateBTCHourlySlug(date: Date = new Date()): string {
        const parts = this.etFormatter.formatToParts(date);
        const month = parts.find((p) => p.type === "month")?.value.toLowerCase();
        const day = parts.find((p) => p.type === "day")?.value;
        const hour = parts.find((p) => p.type === "hour")?.value;
        const period = parts.find((p) => p.type === "dayPeriod")?.value.toLowerCase();

        return `bitcoin-up-or-down-${month}-${day}-${hour}${period}-et`;
    }

    async findBTCHourlyMarkets(): Promise<PolymarketMarket[]> {
        const now = new Date();
        const next = new Date(now.getTime() + 3600000);

        const slugs = [...new Set([
            this.generateBTCHourlySlug(now),
            this.generateBTCHourlySlug(next),
        ])];

        console.log(`🔍 Checking: ${slugs.join(", ")}`);

        // Same approach as 15-min bot
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
                // Try next slug
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
        };
    }

    calculateMinutesLeft(market: PolymarketMarket): number {
        const endDate = market.endDate || market.end_date_iso;
        if (!endDate) return NaN;
        const end = new Date(endDate);
        return (end.getTime() - Date.now()) / 60000;
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

            const size = Math.floor((this.investmentAmount / price) * 100) / 100;

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

    async placeSellOrder(
        conditionId: string,
        tokenId: string,
        sellPrice: number,
        size: number,
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

            const price = Number(sellPrice);
            if (isNaN(price) || price <= 0) {
                console.error(`❌ Invalid sell price: ${sellPrice}`);
                return null;
            }

            console.log(`📤 Placing SELL ${side} order: ${size.toFixed(2)} shares at ${(price * 100).toFixed(1)}¢`);

            const response = await this.client.createAndPostOrder(
                {
                    tokenID: tokenId,
                    price: price,
                    size: size,
                    side: Side.SELL,
                },
                { tickSize, negRisk: market.neg_risk },
                OrderType.GTC
            );

            console.log(`✅ Sell order placed: ${response.orderID} - ${response.status}`);
            return response;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error";
            console.error(`❌ Failed to place sell order:`, errorMessage);
            return null;
        }
    }

    async getOpenOrders(): Promise<any[]> {
        if (!this.client) return [];
        try {
            const orders = await this.client.getOpenOrders();
            return orders || [];
        } catch (e) {
            console.error("❌ Error fetching open orders:", e);
            return [];
        }
    }

    async hasOpenOrderForMarket(conditionId: string): Promise<boolean> {
        const openOrders = await this.getOpenOrders();
        return openOrders.some(order => order.market === conditionId);
    }

    async checkAndSellFilledOrders(): Promise<void> {
        const openOrders = await this.getOpenOrders();
        
        // Filter for BUY orders that have been filled (size_matched > 0)
        const filledBuyOrders = openOrders.filter(order => 
            order.side === "BUY" && Number(order.size_matched || 0) > 0
        );

        if (filledBuyOrders.length === 0) return;

        console.log(`📍 Checking ${filledBuyOrders.length} filled order(s) for sell...`);

        for (const order of filledBuyOrders) {
            try {
                const tokenId = order.asset_id;
                const conditionId = order.market;
                const sizeMatched = Number(order.size_matched);
                const buyPrice = Number(order.price);
                const side = order.outcome === "Up" ? "UP" : "DOWN";

                // Get current price
                const priceRes = await this.client?.getPrice(tokenId, "SELL");
                const currentPrice = Number(priceRes?.price || 0);
                const currentCents = currentPrice * 100;

                console.log(`   ${side}: bought ${sizeMatched.toFixed(2)} at ${(buyPrice * 100).toFixed(1)}¢, now ${currentCents.toFixed(1)}¢`);

                if (currentPrice >= 0.99) {
                    console.log(`🎉 ${side} hit 99¢! Selling ${sizeMatched.toFixed(2)} shares`);
                    const sellOrder = await this.placeSellOrder(
                        conditionId,
                        tokenId,
                        0.99,
                        sizeMatched,
                        side as "UP" | "DOWN"
                    );
                    if (sellOrder?.orderID) {
                        console.log(`✅ Sell order placed!`);
                    }
                } else {
                    console.log(`   Price ${currentCents.toFixed(1)}¢ < 99¢, holding...`);
                }
            } catch (e) {
                console.error(`❌ Error processing order:`, e);
            }
        }
    }

    async checkMarket(market: PolymarketMarket): Promise<void> {
        const details = market.markets?.[0] || market;
        const conditionId = details.conditionId;
        if (!conditionId) return;

        // Skip if order is being placed (lock)
        if (this.orderLock) return;

        // Check Polymarket API for existing orders in this market
        const hasExistingOrder = await this.hasOpenOrderForMarket(conditionId);
        if (hasExistingOrder) {
            console.log(`⏸️ Already have order in market ${conditionId.slice(0, 8)}...`);
            return;
        }

        const minutesLeft = this.calculateMinutesLeft(details);
        if (isNaN(minutesLeft) || minutesLeft < 0.5 || minutesLeft > this.timeThresholdMinutes) {
            return;
        }

        const prices = await this.getTicketPrices(details);
        if (!prices) return;

        const upCents = prices.up * 100;
        const downCents = prices.down * 100;
        const candidate = prices.candidate;

        console.log(`💰 UP: ${upCents.toFixed(1)}¢ | DOWN: ${downCents.toFixed(1)}¢ | ${minutesLeft.toFixed(1)} min left`);

        // Strategy: Only trade if favorite >= 85%
        if (candidate < 0.85) {
            console.log(`⏳ Candidate ${(candidate * 100).toFixed(1)}¢ < 85¢, skipping`);
            return;
        }

        // Determine which side to buy (the favorite)
        const isUpFavorite = prices.up >= prices.down;
        const tokenId = isUpFavorite ? prices.upTokenId : prices.downTokenId;
        const side = isUpFavorite ? "UP" : "DOWN";

        // Calculate bid price
        let bidPrice: number;
        const orderPrice = 0.92;

        if (candidate > orderPrice) {
            bidPrice = orderPrice;
            if (candidate > 0.95) {
                bidPrice = 0.95;
            }
        } else {
            bidPrice = candidate;
        }

        // Acquire lock
        this.orderLock = true;
        
        try {
            console.log(`🎯 ${side} is favorite at ${(candidate * 100).toFixed(1)}¢ → Bidding at ${(bidPrice * 100).toFixed(1)}¢`);
            await this.placeOrder(conditionId, tokenId, bidPrice, side);
        } finally {
            this.orderLock = false;
        }
    }

    async tick(): Promise<void> {
        try {
            // Check filled orders for sell opportunities (from Polymarket API)
            await this.checkAndSellFilledOrders();

            const markets = await this.findBTCHourlyMarkets();
            if (markets.length === 0) {
                console.log(`⏳ No hourly markets found`);
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
        console.log("🚀 Starting Polymarket BTC Up/Down HOURLY Bot");
        console.log(`Strategy: Buy favorite if >= 85¢, bid at 92¢ (or 95¢ if > 95¢), sell at 99¢`);
        console.log(`Investment: $${this.investmentAmount} per trade`);
        console.log("-".repeat(50));

        await this.initialize();

        this.isRunning = true;
        this.tick();
        this.interval = setInterval(() => this.tick(), this.checkInterval);
    }

    stop(): void {
        if (this.interval) clearInterval(this.interval);
        this.isRunning = false;
        console.log("🛑 Bot stopped");
    }
}

const bot = new PolymarketBot();
bot.start().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
});

process.on("SIGINT", () => bot.stop());
process.on("SIGTERM", () => bot.stop());
