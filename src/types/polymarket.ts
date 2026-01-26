export interface PolymarketMarket {
    id?: string;
    conditionId?: string;
    marketId?: string;
    question?: string;
    slug?: string;
    active?: boolean;
    closed?: boolean;
    endDate?: string;
    end_date_iso?: string;
    clobTokenIds?: string;
    outcomePrices?: string;
    outcomes?: string[];
    markets?: PolymarketMarket[];
    tokens?: Array<{
        token_id: string;
        outcome: string;
        price: number;
    }>;
}

export interface PolymarketOrderBook {
    market: string;
    asset_id: string;
    bids: Array<{ price: string; size: string }>;
    asks: Array<{ price: string; size: string }>;
}

export interface TicketPrices {
    up: number;
    down: number;
    upTokenId: string;
    downTokenId: string;
    candidate: number;
}

export interface ClobMarketResponse {
    condition_id: string;
    question_id: string;
    tokens: Array<{
        token_id: string;
        outcome: string;
        price: number;
        winner: boolean;
    }>;
    minimum_tick_size: number;
    neg_risk: boolean;
}
