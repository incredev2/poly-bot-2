# Polymarket BTC Up/Down Trading Bot

Automated trading bot for Polymarket's Bitcoin Up or Down hourly markets.

## Strategy

- **Buy UP**: If UP price < 50 cents → buy $10
- **Buy DOWN**: If DOWN price < (100 - UP_price - 10) cents → buy $10

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create `.env` file:
```
PRIVATE_KEY=your-private-key-here
FUNDER_ADDRESS=your-polymarket-wallet-address
SIGNATURE_TYPE=1
INVESTMENT_AMOUNT=1
CHECK_INTERVAL=5000
TIME_THRESHOLD_MINUTES=20
```

**Signature Types:**
- `0` = EOA (MetaMask, hardware wallet)
- `1` = Email/Magic wallet  
- `2` = Browser wallet proxy

3. Run the bot:
```bash
# 15-minute markets (btc-updown-15m-{timestamp})
npm run start:15min

# Hourly markets (bitcoin-up-or-down-{month}-{day}-{hour}{am/pm}-et)
npm run start:hourly
```

## Configuration

- `INVESTMENT_AMOUNT` - USD per trade (default: 10)
- `CHECK_INTERVAL` - Milliseconds between checks (default: 5000)
- `TIME_THRESHOLD_MINUTES` - Only trade markets ending within this time (default: 20)

## Important

- Make sure you have USDC in your Polymarket wallet
- If using MetaMask/EOA, set token allowances first
