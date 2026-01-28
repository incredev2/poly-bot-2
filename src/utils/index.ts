import { StartConfig } from "../config";

export function validateConfig(config: StartConfig) {
    const errors: string[] = [];
    
    if (!config.privateKey.trim()) {
        errors.push('Private Key is required');
    }
    if (!config.investmentAmount || Number(config.investmentAmount) <= 0) {
        errors.push('Investment Amount must be greater than 0');
    }
    if (!config.checkInterval || Number(config.checkInterval) <= 0) {
        errors.push('Check Interval must be greater than 0');
    }

    if(!config.funderAddress.trim()) {
        errors.push('Funder Address is required');
    }
    if (!config.consecutiveCandlesCount || Number(config.consecutiveCandlesCount) <= 0) {
        errors.push('Consecutive Candles Count must be greater than 0');
    }

    if(errors.length === 0) {
        return {
            result: true,
            errors: [], 
        };
    } else {
        return {
            result: false,
            errors: errors,
        };
    }
}