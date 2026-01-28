import dotenv from 'dotenv';

dotenv.config();

export interface ApiConfig {
    privateKey: string;
    baseUrl: string;
    gammaUrl: string;
}

export interface BotConfig {
    checkInterval: number;
    investmentAmount: number;
    timeThresholdMinutes: number;
}

export interface Config {
    api: ApiConfig;
    bot: BotConfig;
}

export interface StartConfig {
    privateKey: string;
    investmentAmount: number;
    checkInterval: number;
    funderAddress: string;
    consecutiveCandlesCount: number;
}

export const config: Config = {
    api: {
        privateKey: process.env.PRIVATE_KEY || '',
        baseUrl: 'https://clob.polymarket.com',
        gammaUrl: 'https://gamma-api.polymarket.com',
    },
    bot: {
        checkInterval: parseInt(process.env.CHECK_INTERVAL || '5000', 10),
        investmentAmount: parseFloat(process.env.INVESTMENT_AMOUNT || '10'),
        timeThresholdMinutes: parseInt(process.env.TIME_THRESHOLD_MINUTES || '20', 10),
    },
};

export function validateConfig(): string[] {
    const errors: string[] = [];

    if (!config.api.privateKey) {
        errors.push('PRIVATE_KEY is not set');
    }

    return errors;
}
