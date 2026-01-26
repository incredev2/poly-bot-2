# Polymarket Bot UI

A React + TypeScript + Tailwind CSS dashboard for monitoring and controlling the Polymarket trading bot.

## Features

- 📊 Real-time bot status monitoring
- 💰 Current bet amount tracking
- 📈 Win/Loss statistics
- 📝 Trading history
- ⚙️ Configuration management (no .env file needed)
- 🎨 Modern UI with Tailwind CSS

## Setup

1. Install dependencies:
```bash
npm install
```

2. Start the server (runs on port 3000):
```bash
npm run start:ui
```

3. In another terminal, start the UI dev server (runs on port 5173):
```bash
npm run ui
```

4. Open your browser to `http://localhost:5173`

## Usage

### Starting the Bot

1. Configure your settings in the "Configuration" panel:
   - Private Key
   - Investment Amount (initial bet)
   - Check Interval (ms)
   - Signature Type (0=EOA, 1=Email/Magic, 2=Browser proxy)
   - Funder Address

2. Click "Update Config" to save your settings

3. Click "Start Bot" to begin trading

### Monitoring

The dashboard shows:
- **Bot Status**: Running/Stopped indicator
- **Current Bet Amount**: Current martingale bet amount
- **Initial Amount**: Starting bet amount
- **Wins/Losses**: Total count
- **Last Result**: Most recent win/loss
- **Tracked Markets**: Number of active orders
- **History**: Last 10 market results

## API Endpoints

- `GET /api/status` - Get bot status
- `GET /api/config` - Get current configuration
- `POST /api/config` - Update configuration
- `POST /api/start` - Start the bot
- `POST /api/stop` - Stop the bot

## Development

- UI dev server: `npm run ui` (Vite on port 5173)
- Backend server: `npm run dev:ui` (Express on port 3000)
