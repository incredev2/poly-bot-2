import React, { useState, useEffect } from 'react';

interface Status {
  running: boolean;
  currentBetAmount: number;
  initialAmount: number;
  winCount: number;
  lossCount: number;
  lastResult: "win" | "loss" | null;
  lastMarketId: string | null;
  history: Array<{ marketId: string; result: "win" | "loss"; betAmount: number; side: "UP" | "DOWN"; timestamp: string }>;
  trackedMarketsCount: number;
  tradingSide: "UP" | "DOWN";
}

interface Config {
  privateKey: string;
  investmentAmount: number;
  checkInterval: number;
  signatureType: number;
  funderAddress: string;
  tradingSide: "UP" | "DOWN";
}

const API_BASE = 'http://localhost:3000/api';

function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [configForm, setConfigForm] = useState({
    privateKey: '',
    investmentAmount: '',
    checkInterval: '',
    signatureType: '1',
    funderAddress: '',
    tradingSide: 'UP' as "UP" | "DOWN",
  });
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  const fetchStatus = async () => {
    try {
      const res = await fetch(`${API_BASE}/status`);
      const data = await res.json();
      console.log('Status fetched:', {
        running: data.running,
        winCount: data.winCount,
        lossCount: data.lossCount,
        historyLength: data.history?.length || 0,
        lastResult: data.lastResult,
        history: data.history
      });
      setStatus(data);
    } catch (error) {
      console.error('Failed to fetch status:', error);
    }
  };

  const fetchConfig = async () => {
    try {
      const res = await fetch(`${API_BASE}/config`);
      const data = await res.json();
      if (data.error) {
        console.error('Config error:', data.error);
        return;
      }
      setConfig(data);
      // Load initial values from config on first load only
      setConfigForm(prev => {
        // Only set if form is empty (first load)
        const isFirstLoad = !prev.investmentAmount && !prev.checkInterval;
        return {
          privateKey: prev.privateKey || '', // Private key is never pre-filled for security
          investmentAmount: isFirstLoad ? (data.investmentAmount?.toString() || '') : prev.investmentAmount,
          checkInterval: isFirstLoad ? (data.checkInterval?.toString() || '') : prev.checkInterval,
          signatureType: isFirstLoad ? (data.signatureType?.toString() || '1') : prev.signatureType,
          funderAddress: isFirstLoad ? (data.funderAddress || '') : prev.funderAddress,
          tradingSide: isFirstLoad ? (data.tradingSide || 'UP') : prev.tradingSide,
        };
      });
    } catch (error) {
      console.error('Failed to fetch config:', error);
    }
  };

  useEffect(() => {
    fetchStatus();
    fetchConfig();
    const interval = setInterval(fetchStatus, 2000); // Poll every 2 seconds
    return () => clearInterval(interval);
  }, []);

  const validateConfig = (): boolean => {
    const errors: string[] = [];
    
    if (!configForm.privateKey.trim()) {
      errors.push('Private Key is required');
    }
    if (!configForm.investmentAmount || parseFloat(configForm.investmentAmount) <= 0) {
      errors.push('Investment Amount must be greater than 0');
    }
    if (!configForm.checkInterval || parseInt(configForm.checkInterval) <= 0) {
      errors.push('Check Interval must be greater than 0');
    }
    
    setValidationErrors(errors);
    return errors.length === 0;
  };

  const handleStart = async () => {
    // First update config, then validate
    setLoading(true);
    setValidationErrors([]);
    
    try {
      // Update config first
      const configRes = await fetch(`${API_BASE}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          privateKey: configForm.privateKey || undefined,
          investmentAmount: configForm.investmentAmount ? parseFloat(configForm.investmentAmount) : undefined,
          checkInterval: configForm.checkInterval ? parseInt(configForm.checkInterval) : undefined,
          signatureType: configForm.signatureType ? parseInt(configForm.signatureType) : undefined,
          funderAddress: configForm.funderAddress || undefined,
          tradingSide: configForm.tradingSide,
        }),
      });
      
      const configData = await configRes.json();
      if (configData.error) {
        setMessage({ type: 'error', text: configData.error });
        setLoading(false);
        return;
      }
      
      // Validate before starting
      if (!validateConfig()) {
        setMessage({ type: 'error', text: 'Please fix validation errors before starting' });
        setLoading(false);
        return;
      }
      
      // Start bot
      const res = await fetch(`${API_BASE}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tradingSide: configForm.tradingSide,
        }),
      });
      const data = await res.json();
      if (data.error) {
        setMessage({ type: 'error', text: data.error });
      } else {
        setMessage({ type: 'success', text: 'Bot started successfully' });
        fetchStatus();
      }
    } catch (error) {
      setMessage({ type: 'error', text: 'Failed to start bot' });
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/stop`, { method: 'POST' });
      const data = await res.json();
      if (data.error) {
        setMessage({ type: 'error', text: data.error });
      } else {
        setMessage({ type: 'success', text: 'Bot stopped successfully' });
        fetchStatus();
      }
    } catch (error) {
      setMessage({ type: 'error', text: 'Failed to stop bot' });
    } finally {
      setLoading(false);
    }
  };

  const handleConfigUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    
    // Prevent config update while bot is running
    if (status?.running) {
      setMessage({ type: 'error', text: 'Cannot update config while bot is running. Please stop the bot first.' });
      return;
    }
    
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          privateKey: configForm.privateKey || undefined,
          investmentAmount: configForm.investmentAmount ? parseFloat(configForm.investmentAmount) : undefined,
          checkInterval: configForm.checkInterval ? parseInt(configForm.checkInterval) : undefined,
          signatureType: configForm.signatureType ? parseInt(configForm.signatureType) : undefined,
          funderAddress: configForm.funderAddress || undefined,
          tradingSide: configForm.tradingSide,
        }),
      });
      const data = await res.json();
      if (data.error) {
        setMessage({ type: 'error', text: data.error });
      } else {
        setMessage({ type: 'success', text: 'Config updated successfully' });
        fetchConfig();
      }
    } catch (error) {
      setMessage({ type: 'error', text: 'Failed to update config' });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-100 p-8">
      <div className="max-w-7xl mx-auto">
        <h1 className="text-4xl font-bold text-gray-900 mb-8">Polymarket Bot Dashboard</h1>

        {message && (
          <div className={`mb-4 p-4 rounded-lg ${
            message.type === 'success' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
          }`}>
            {message.text}
          </div>
        )}

        {validationErrors.length > 0 && (
          <div className="mb-4 p-4 rounded-lg bg-red-100 text-red-800">
            <p className="font-semibold mb-2">Validation Errors:</p>
            <ul className="list-disc list-inside">
              {validationErrors.map((error, idx) => (
                <li key={idx}>{error}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Status Card */}
          <div className="bg-white rounded-lg shadow-lg p-6">
            <h2 className="text-2xl font-semibold mb-4">Bot Status</h2>
            
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-gray-600">Status:</span>
                <span className={`px-3 py-1 rounded-full text-sm font-medium ${
                  status?.running ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
                }`}>
                  {status?.running ? 'Running' : 'Stopped'}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-gray-600">Current Bet Amount:</span>
                <span className="text-xl font-bold text-blue-600">${(status?.currentBetAmount ?? 0).toFixed(2)}</span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-gray-600">Initial Amount:</span>
                <span className="text-lg font-semibold">${(status?.initialAmount ?? 0).toFixed(2)}</span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-gray-600">Wins:</span>
                <span className="text-lg font-semibold text-green-600">{status?.winCount || 0}</span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-gray-600">Losses:</span>
                <span className="text-lg font-semibold text-red-600">{status?.lossCount || 0}</span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-gray-600">Last Result:</span>
                <span className={`px-3 py-1 rounded-full text-sm font-medium ${
                  status?.lastResult === 'win' ? 'bg-green-100 text-green-800' : 
                  status?.lastResult === 'loss' ? 'bg-red-100 text-red-800' : 
                  'bg-gray-100 text-gray-800'
                }`}>
                  {status?.lastResult ? status.lastResult.toUpperCase() : 'N/A'}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-gray-600">Tracked Markets:</span>
                <span className="text-lg font-semibold">{status?.trackedMarketsCount || 0}</span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-gray-600">Trading Side:</span>
                <span className={`px-3 py-1 rounded-full text-sm font-medium ${
                  status?.tradingSide === 'UP' ? 'bg-blue-100 text-blue-800' : 'bg-purple-100 text-purple-800'
                }`}>
                  {status?.tradingSide || 'UP'}
                </span>
              </div>

              <div className="pt-4 border-t">
                <button
                  onClick={status?.running ? handleStop : handleStart}
                  disabled={loading}
                  className={`w-full py-2 px-4 rounded-lg font-semibold ${
                    status?.running
                      ? 'bg-red-500 hover:bg-red-600 text-white'
                      : 'bg-green-500 hover:bg-green-600 text-white'
                  } disabled:opacity-50`}
                >
                  {loading ? 'Loading...' : status?.running ? 'Stop Bot' : 'Start Bot'}
                </button>
              </div>
            </div>
          </div>

          {/* Config Card */}
          <div className="bg-white rounded-lg shadow-lg p-6">
            <h2 className="text-2xl font-semibold mb-4">Configuration</h2>
            
            {status?.running && (
              <div className="mb-4 p-3 bg-yellow-100 border border-yellow-400 rounded-lg text-yellow-800">
                <p className="font-semibold">⚠️ Bot is running</p>
                <p className="text-sm">Configuration cannot be updated while the bot is running. Please stop the bot first.</p>
              </div>
            )}
            
            <form onSubmit={handleConfigUpdate} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Private Key <span className="text-red-500">*</span>
                </label>
                <input
                  type="password"
                  value={configForm.privateKey}
                  onChange={(e) => {
                    setConfigForm({ ...configForm, privateKey: e.target.value });
                    setValidationErrors([]);
                  }}
                  placeholder={config?.privateKey || 'Enter private key'}
                  disabled={status?.running}
                  className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
                    validationErrors.some(e => e.includes('Private Key')) ? 'border-red-500' : 'border-gray-300'
                  } ${status?.running ? 'bg-gray-100 cursor-not-allowed' : ''}`}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Investment Amount ($) <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={configForm.investmentAmount}
                  onChange={(e) => {
                    setConfigForm({ ...configForm, investmentAmount: e.target.value });
                    setValidationErrors([]);
                  }}
                  placeholder={config?.investmentAmount?.toString() || '10'}
                  disabled={status?.running}
                  className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
                    validationErrors.some(e => e.includes('Investment Amount')) ? 'border-red-500' : 'border-gray-300'
                  } ${status?.running ? 'bg-gray-100 cursor-not-allowed' : ''}`}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Check Interval (ms) <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  min="1000"
                  value={configForm.checkInterval}
                  onChange={(e) => {
                    setConfigForm({ ...configForm, checkInterval: e.target.value });
                    setValidationErrors([]);
                  }}
                  placeholder={config?.checkInterval?.toString() || '5000'}
                  disabled={status?.running}
                  className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
                    validationErrors.some(e => e.includes('Check Interval')) ? 'border-red-500' : 'border-gray-300'
                  } ${status?.running ? 'bg-gray-100 cursor-not-allowed' : ''}`}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Signature Type
                </label>
                <select
                  value={configForm.signatureType}
                  onChange={(e) => setConfigForm({ ...configForm, signatureType: e.target.value })}
                  disabled={status?.running}
                  className={`w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
                    status?.running ? 'bg-gray-100 cursor-not-allowed' : ''
                  }`}
                >
                  <option value="0">0 - EOA (MetaMask)</option>
                  <option value="1">1 - Email/Magic wallet</option>
                  <option value="2">2 - Browser wallet proxy</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Funder Address
                </label>
                <input
                  type="text"
                  value={configForm.funderAddress}
                  onChange={(e) => setConfigForm({ ...configForm, funderAddress: e.target.value })}
                  placeholder={config?.funderAddress || 'Enter funder address'}
                  disabled={status?.running}
                  className={`w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent ${
                    status?.running ? 'bg-gray-100 cursor-not-allowed' : ''
                  }`}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Trading Side
                </label>
                <div className="flex items-center space-x-4">
                  <button
                    type="button"
                    onClick={() => !status?.running && setConfigForm({ ...configForm, tradingSide: 'UP' })}
                    disabled={status?.running}
                    className={`flex-1 py-2 px-4 rounded-lg font-semibold transition-colors ${
                      configForm.tradingSide === 'UP'
                        ? 'bg-blue-500 text-white'
                        : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                    } ${status?.running ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    UP
                  </button>
                  <button
                    type="button"
                    onClick={() => !status?.running && setConfigForm({ ...configForm, tradingSide: 'DOWN' })}
                    disabled={status?.running}
                    className={`flex-1 py-2 px-4 rounded-lg font-semibold transition-colors ${
                      configForm.tradingSide === 'DOWN'
                        ? 'bg-purple-500 text-white'
                        : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                    } ${status?.running ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    DOWN
                  </button>
                </div>
                <p className="mt-2 text-sm text-gray-500">
                  {configForm.tradingSide === 'UP' 
                    ? 'Will buy UP tickets when UP price < 50¢'
                    : 'Will buy DOWN tickets when DOWN price < 50¢'}
                </p>
              </div>

              <button
                type="submit"
                disabled={loading || status?.running}
                className={`w-full py-2 px-4 rounded-lg font-semibold ${
                  status?.running
                    ? 'bg-gray-400 text-gray-200 cursor-not-allowed'
                    : 'bg-blue-500 hover:bg-blue-600 text-white'
                } disabled:opacity-50`}
              >
                {status?.running ? 'Bot Running - Config Disabled' : loading ? 'Updating...' : 'Update Config'}
              </button>
            </form>
          </div>
        </div>

        {/* History Card */}
        <div className="mt-6 bg-white rounded-lg shadow-lg p-6">
          <h2 className="text-2xl font-semibold mb-4">Recent History</h2>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 px-4">Market ID</th>
                  <th className="text-left py-2 px-4">Side</th>
                  <th className="text-left py-2 px-4">Result</th>
                  <th className="text-left py-2 px-4">Bet Amount</th>
                  <th className="text-left py-2 px-4">Timestamp</th>
                </tr>
              </thead>
              <tbody>
                {status?.history && Array.isArray(status.history) && status.history.length > 0 ? (
                  status.history.slice().reverse().map((entry, idx) => (
                    <tr key={idx} className="border-b">
                      <td className="py-2 px-4 font-mono text-sm">{entry.marketId ? entry.marketId.slice(0, 8) + '...' : 'N/A'}</td>
                      <td className="py-2 px-4">
                        <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                          entry.side === 'UP' ? 'bg-blue-100 text-blue-800' : 'bg-purple-100 text-purple-800'
                        }`}>
                          {entry.side || 'UP'}
                        </span>
                      </td>
                      <td className="py-2 px-4">
                        <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                          entry.result === 'win' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                        }`}>
                          {entry.result.toUpperCase()}
                        </span>
                      </td>
                      <td className="py-2 px-4">${(entry.betAmount ?? 0).toFixed(2)}</td>
                      <td className="py-2 px-4 text-sm text-gray-600">
                        {new Date(entry.timestamp).toLocaleString()}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} className="py-4 text-center text-gray-500">
                      {status?.history === undefined ? 'Loading...' : `No history yet (History array: ${status?.history ? 'exists' : 'null'}, Length: ${status?.history?.length || 0})`}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
