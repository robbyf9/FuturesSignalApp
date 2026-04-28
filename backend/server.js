/**
 * Binance Futures Scalping Bot - Backend Server (v4.0 Win Rate Overhaul)
 * 
 * Tujuan: Auto-scalping bot 15m, Wilder RSI, positive R:R, candle-close confirm, pct trailing SL.
 * Dipakai oleh: Frontend dashboard, Telegram bot, cron scheduler.
 * Dependensi: express, axios, ws, node-cron, crypto (Binance Futures API).
 * Fungsi utama: runBackgroundScanner, executeBinanceTrade, checkTradeLevels, 
 *              moveStopLossToBreakEven, closePartialPosition, monitorActiveTrades.
 * Side effects: REST API calls ke Binance, WebSocket stream, file I/O (trades/history/settings).
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const dotenv = require('dotenv');
const cron = require('node-cron');
const fs = require('fs');
const crypto = require('crypto');
const WebSocket = require('ws');

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
// Alwaysdata Nginx reverse proxy mengirimkan IPv6 lewat process.env.IP 
const HOST = process.env.IP || '0.0.0.0';
const DEFAULT_BINANCE_BASE_URL = 'https://fapi.binance.com';
const REQUEST_TIMEOUT_MS = Number(process.env.BINANCE_TIMEOUT_MS) || 15000;

function parseBaseUrls() {
  const raw =
    process.env.BINANCE_BASE_URLS ||
    process.env.BINANCE_BASE_URL ||
    DEFAULT_BINANCE_BASE_URL;

  const urls = Array.from(
    new Set(
      raw
        .split(',')
        .map((value) => value.trim().replace(/\/+$/, ''))
        .filter(Boolean)
    )
  );
  
  // Always add fallback to official Binance if proxy is used
  if (urls.length > 0 && !urls.includes('https://fapi.binance.com')) {
    urls.push('https://fapi.binance.com');
    console.log('[startup] Added fallback to official Binance endpoint');
  }
  
  return urls;
}

const BINANCE_BASE_URLS = parseBaseUrls();
let activeBaseIndex = 0;

// URL untuk Market Data (Scanner, Klines, Ticker) — SELALU gunakan mainnet/proxy
function getMarketBaseUrl() {
  if (BINANCE_BASE_URLS.length > 0) {
    return BINANCE_BASE_URLS[activeBaseIndex];
  }
  return 'https://fapi.binance.com';
}

// URL untuk Trading API (Order, Position) — Bisa pakai proxy jika diaktifkan
function getActiveBaseUrl() {
  const USE_TESTNET = process.env.USE_BINANCE_TESTNET === 'true';
  const testnetProxy = process.env.BINANCE_TESTNET_URL; // Optional custom proxy for testnet

  if (USE_TESTNET) {
    return testnetProxy || 'https://testnet.binancefuture.com';
  }
  return getMarketBaseUrl();
}

// Global Live State (Memory Cache)
let livePrices = {};
let wsConnection = null;
let wsStatus = 'DISCONNECTED';
let cachedActiveTrades = null; // Cache untuk cegah I/O berlebih
let lastNotified = {}; // Tracker anti-spam notifikasi (symbol_type -> timestamp)
const recentlyClosed = new Map(); // Cache anti-duplicate (symbol -> timestamp)
const leverageCache = new Map(); // Global Cache for leverage settings
let currentOpenPositions = 0; // Global tracker for open positions
let consecutiveLosses = 0; // PRO: Consecutive loss tracker (reset on win)
let cachedBalance = null; // PRO: Cached account balance
let lastBalanceFetch = 0; // PRO: Last balance fetch timestamp

function rotateBaseUrl() {
  if (BINANCE_BASE_URLS.length <= 1) return false;
  activeBaseIndex = (activeBaseIndex + 1) % BINANCE_BASE_URLS.length;
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildRequestUrl(config = {}) {
  const baseURL = config.baseURL || getActiveBaseUrl();
  const requestPath = config.url || '';

  try {
    return new URL(requestPath, baseURL).toString();
  } catch {
    return `${baseURL}${requestPath}`;
  }
}

function isNetworkError(error) {
  return !error.response && Boolean(error.code);
}

function getErrorStatusCode(error) {
  if (error.response?.status) return error.response.status >= 500 ? 502 : error.response.status;
  if (isNetworkError(error)) return 503;
  return 500;
}

function formatAxiosError(error) {
  const target = buildRequestUrl(error.config || {});

  if (error.response) {
    const details =
      error.response.data?.msg ||
      error.response.data?.message ||
      error.response.statusText ||
      'Unexpected exchange response';

    return `Binance returned HTTP ${error.response.status} for ${target}: ${details}`;
  }

  switch (error.code) {
    case 'ECONNREFUSED':
      return `Connection refused by Binance endpoint ${target}. This usually means the host is blocked, unreachable from this network, or a proxy/firewall is rejecting the connection.`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `DNS lookup failed for Binance endpoint ${target}. Check your internet connection, DNS settings, or VPN/proxy configuration.`;
    case 'ETIMEDOUT':
    case 'ECONNABORTED':
      return `Request to Binance timed out for ${target}. The exchange or your network may be slow or blocked.`;
    case 'ECONNRESET':
      return `Connection to Binance was reset for ${target}. This usually points to an unstable network or an upstream block.`;
    default:
      return `Request to Binance failed for ${target}${error.code ? ` (${error.code})` : ''}: ${error.message}`;
  }
}

function normalizeAxiosError(error) {
  if (!error || error._normalizedForUser) return error;

  error.originalMessage = error.message;
  error.message = formatAxiosError(error);
  error._normalizedForUser = true;
  return error;
}

function fmtP(val) {
  if (!val) return '0.00';
  return val > 100 ? val.toFixed(2) : (val > 1 ? val.toFixed(4) : val.toFixed(6));
}

function handleRouteError(res, error, fallbackLabel) {
  const normalized = normalizeAxiosError(error);
  const message = normalized?.message || fallbackLabel || 'Unknown server error';

  console.error(`[ERROR] ${message}`);
  res.status(getErrorStatusCode(normalized)).json({
    error: message,
    baseURL: getActiveBaseUrl(),
  });
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend/public')));

let WATCHLIST = (process.env.CUSTOM_WATCHLIST || 'BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,ADAUSDT,MATICUSDT,DOTUSDT,LTCUSDT,TRXUSDT').split(',').map(s => s.trim().toUpperCase());

async function updateWatchlist() {
  if (process.env.USE_FIXED_WATCHLIST === 'true') {
    const list = (process.env.CUSTOM_WATCHLIST || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    if (list.length > 0) {
      WATCHLIST = list;
      console.log(`[system] Mode FIXED aktif: Memantau ${WATCHLIST.length} koin utama.`);
      return;
    }
  }
  
  try {
    const { data } = await safeGet('/fapi/v1/ticker/24hr');
    const blacklist = (process.env.SYMBOL_BLACKLIST || '').split(',').map(s => s.trim().toUpperCase());
    
    const eligible = data
      .filter((item) => {
        const symbol = item.symbol;
        if (!symbol.endsWith('USDT') || symbol.includes('_')) return false;
        
        // Anti-Blacklist check
        if (blacklist.includes(symbol)) return false;

        // EXCLUDE LEVERAGED TOKENS (BULL, BEAR, UP, DOWN)
        const isLeveraged = /BULL|BEAR|UP|DOWN/.test(symbol);
        if (isLeveraged && symbol !== 'SUPERUSDT' && symbol !== 'JUPUSDT' && symbol !== 'ICPUSDT' && symbol !== 'LUPUSDT') {
           return false;
        }

        // Professional Volume Threshold (Default List: 50jt USDT)
        const minVol = parseFloat(process.env.SCANNER_MIN_VOLUME_USDT) || 50000000;
        return parseFloat(item.quoteVolume) >= minVol;
      })
      .map((item) => item.symbol);

    if (eligible.length > 0) {
      WATCHLIST = eligible;
      console.log(`[system] Watchlist diperbarui otomatis: ${WATCHLIST.length} koin siap discan.`);
    }
  } catch (error) {
    console.error('[system] Gagal memperbarui watchlist otomatis:', error.message);
  }
}

// Auto-refresh watchlist every 4 hours
setInterval(updateWatchlist, 4 * 60 * 60 * 1000);


// Axios instance untuk MARKET DATA — selalu pakai mainnet/proxy
const api = axios.create({
  baseURL: getMarketBaseUrl(),
  timeout: REQUEST_TIMEOUT_MS,
  headers: {
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0',
  },
});

api.interceptors.request.use((config) => {
  // Market data selalu pakai mainnet, bukan testnet
  config.baseURL = getMarketBaseUrl();
  return config;
});

// Helper: Safe GET with Auto-Rotation & Retries
async function safeGet(url, params = {}, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    try {
      const result = await api.get(url, { params });
      if (i > 0) {
        console.log(`[api] Recovered after ${i} retry/ies`);
      }
      return result;
    } catch (error) {
      const status = error.response?.status;
      const code = error.code;
      const isLastAttempt = i >= retries;
      
      // Determine if we should retry
      const shouldRetry = !isLastAttempt && (
        status === 429 ||   // Rate limited
        status === 503 ||   // Service unavailable
        status === 502 ||   // Bad gateway
        code === 'ECONNREFUSED' ||
        code === 'ETIMEDOUT' ||
        code === 'ECONNRESET' ||
        !error.response    // Network error (no response)
      );

      if (shouldRetry) {
        // Increase wait time for consecutive retries
        const baseWait = status === 429 ? 2000 : status === 503 ? 1000 : 500;
        const wait = baseWait + (i * 500);
        console.warn(`[api] ${url} failed (status: ${status || code}). Retry ${i + 1}/${retries} after ${wait}ms...`);
        
        // Try next URL on network/connection errors
        if (!error.response || status >= 500) {
          rotateBaseUrl();
        }
        
        await sleep(wait);
        continue;
      }
      
      // If no more retries, throw
      throw error;
    }
  }
}

// -------------------------------------------------------------
// KONFIGURASI & AUTHENTICATION BINANCE (TESTNET/LIVE)
// -------------------------------------------------------------
const BINANCE_API_KEY = process.env.BINANCE_API_KEY;
const BINANCE_SECRET_KEY = process.env.BINANCE_SECRET_KEY;
const USE_TESTNET = process.env.USE_BINANCE_TESTNET === 'true';
const TESTNET_BASE_URL = 'https://testnet.binancefuture.com';

const tradingApi = axios.create({
  baseURL: USE_TESTNET ? TESTNET_BASE_URL : getActiveBaseUrl(),
  timeout: 15000, // Slightly longer for production stability
  headers: {
    'X-MBX-APIKEY': BINANCE_API_KEY,
    'Content-Type': 'application/x-www-form-urlencoded'
  }
});

// Interceptor for Auto-Retry on Trading API (Very important for production)
tradingApi.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error.config;
    // Retry on Network Errors or Binance 5xx errors (Proxy or Server Down)
    const shouldRetry = Boolean(config) && 
      (!error.response || (error.response.status >= 500 && error.response.status < 600));

    if (!shouldRetry || (config.__retryCount || 0) >= 3) {
      return Promise.reject(normalizeAxiosError(error));
    }

    config.__retryCount = (config.__retryCount || 0) + 1;
    const delay = 1000 * config.__retryCount;
    console.warn(`[trading-api] Error ${error.response?.status || 'Network'}. Retrying ${config.__retryCount}/3 after ${delay}ms...`);
    await sleep(delay);
    return tradingApi(config);
  }
);

function signRequest(params) {
  const timestamp = Date.now();
  const queryString = Object.keys(params)
    .map(key => `${key}=${encodeURIComponent(params[key])}`)
    .join('&') + `&timestamp=${timestamp}`;
  
  const signature = crypto
    .createHmac('sha256', BINANCE_SECRET_KEY)
    .update(queryString)
    .digest('hex');
    
  return `${queryString}&signature=${signature}`;
}

let exchangeInfoCache = null;
let lastExchangeInfoFetch = 0;

async function getExchangeInfo() {
  const now = Date.now();
  // Refresh cache tiap 12 jam untuk akurasi presisi koin baru
  if (exchangeInfoCache && (now - lastExchangeInfoFetch < 12 * 60 * 60 * 1000)) {
    return exchangeInfoCache;
  }
  try {
    const res = await api.get('/fapi/v1/exchangeInfo');
    exchangeInfoCache = res.data;
    lastExchangeInfoFetch = now;
    return exchangeInfoCache;
  } catch (err) {
    console.error('[binance] Gagal ambil Exchange Info:', err.message);
    return exchangeInfoCache; // Fallback ke cache lama jika ada
  }
}

function getSymbolPrecision(symbol, info) {
  // Enhanced fallback logic for small coins like PORT3 or ENA
  const defaultPrecision = { price: 6, quantity: 2 }; // More generous fallback for price
  if (!info) return defaultPrecision;
  
  const sym = info.symbols.find(s => s.symbol === symbol);
  if (!sym) return defaultPrecision;
  
  const priceFilter = sym.filters.find(f => f.filterType === 'PRICE_FILTER');
  const lotFilter = sym.filters.find(f => f.filterType === 'LOT_SIZE');
  
  const tickSize = priceFilter ? parseFloat(priceFilter.tickSize) : 0.000001;
  const stepSize = lotFilter ? parseFloat(lotFilter.stepSize) : 0.01;
  
  return {
    price: Math.max(0, Math.round(-Math.log10(tickSize))),
    quantity: Math.max(0, Math.round(-Math.log10(stepSize)))
  };
}

// -------------------------------------------------------------
// PRIVATE BINANCE FETCHERS (SIGNED)
// -------------------------------------------------------------
async function fetchSigned(method, endpoint, params = {}) {
  const queryString = signRequest(params);
  const config = {
    method,
    url: `${endpoint}?${queryString}`
  };
  try {
    const res = await tradingApi(config);
    return res.data;
  } catch (err) {
    // Re-throw so callers can handle specifically, but normalized
    throw err;
  }
}

async function getBinancePositions() {
  try {
    // Filter hanya posisi yang memiliki jumlah koin (aktif)
    const positions = await fetchSigned('GET', '/fapi/v2/positionRisk');
    if (!positions || !Array.isArray(positions)) return [];
    return positions.filter(p => parseFloat(p.positionAmt) !== 0);
  } catch (err) {
    console.error('[binance] Gagal ambil posisi:', err.response?.data?.msg || err.message);
    return null;
  }
}

/**
 * Menganalisis Kondisi BTC (Market Sentiment Filter)
 * Hanya Long jika BTC di atas EMA 20 (5 menit)
 */
async function getBTCStatus() {
  try {
    const res = await safeGet('/fapi/v1/klines', { symbol: 'BTCUSDT', interval: '5m', limit: 50 });
    const klines = res.data;
    const closes = klines.map(k => parseFloat(k[4]));
    const currentPrice = closes[closes.length - 1];
    const prevPrice15m = closes[closes.length - 4] || closes[0]; // ~15 mins ago
    
    const priceChange15m = ((currentPrice - prevPrice15m) / prevPrice15m) * 100;
    const ema20 = calcEMA(closes, 20);
    
    return {
       price: currentPrice,
       priceChange15m: priceChange15m,
       ema20: ema20,
       isBullish: currentPrice > ema20,
       isPanic: closes[closes.length - 1] < closes[closes.length - 2] * 0.992 // Flash Crash 0.8% in 5m (Relaxed from 0.5%)
    };
  } catch (err) {
    console.error('[market-watch] Gagal ambil status BTC:', err.message);
    return { isBullish: true, isPanic: false, priceChange15m: 0, price: 0 }; // Default safe if API fails
  }
}

async function getBinanceOpenOrders(symbol = null) {
  try {
    const params = symbol ? { symbol } : {};
    const orders = await fetchSigned('GET', '/fapi/v1/openOrders', params);
    return Array.isArray(orders) ? orders : [];
  } catch (err) {
    console.error(`[binance] Gagal ambil open orders ${symbol || ''}:`, err.response?.data?.msg || err.message);
    return [];
  }
}

// =============================================================
// ALGO ORDER API (For SL/TP/Trailing - Binance Migration 2025+)
// =============================================================

/**
 * Place a conditional order (SL/TP) via Algo Order API
 * Replaces: tradingApi.post('/fapi/v1/order', ...) for STOP_MARKET / TAKE_PROFIT_MARKET
 */
async function placeAlgoOrder({ symbol, side, type, triggerPrice, closePosition = 'true', workingType = 'MARK_PRICE' }) {
  const params = signRequest({
    symbol,
    side,
    type,
    triggerPrice,
    closePosition,
    workingType,
    algoType: 'CONDITIONAL'
  });
  const res = await tradingApi.post('/fapi/v1/algoOrder', params);
  return res.data;
}

/**
 * Get all open Algo Orders (for checking if SL/TP exists)
 * Replaces: getBinanceOpenOrders() filtering by type === 'STOP_MARKET'
 */
async function getOpenAlgoOrders(symbol = null) {
  try {
    const params = {};
    if (symbol) params.symbol = symbol;
    const orders = await fetchSigned('GET', '/fapi/v1/openAlgoOrders', params);
    // API returns { rows: [...] }
    if (orders && Array.isArray(orders.rows)) return orders.rows;
    if (Array.isArray(orders)) return orders;
    return [];
  } catch (err) {
    console.error(`[binance] Gagal ambil open algo orders ${symbol || ''}:`, err.response?.data?.msg || err.message);
    return [];
  }
}

/**
 * Cancel all open Algo Orders for a symbol
 * Replaces: fetchSigned('DELETE', '/fapi/v1/order', { symbol, orderId })
 */
async function cancelAllAlgoOrders(symbol) {
  try {
    await fetchSigned('DELETE', '/fapi/v1/algoOpenOrders', { symbol });
    console.log(`[algo] All algo orders cancelled for ${symbol}`);
    return true;
  } catch (err) {
    console.error(`[algo] Gagal cancel algo orders ${symbol}:`, err.response?.data?.msg || err.message);
    return false;
  }
}

/**
 * Cancel a specific Algo Order by algoId
 */
async function cancelAlgoOrder(symbol, algoId) {
  try {
    await fetchSigned('DELETE', '/fapi/v1/algoOrder', { symbol, algoId });
    console.log(`[algo] Algo order ${algoId} cancelled for ${symbol}`);
    return true;
  } catch (err) {
    console.error(`[algo] Gagal cancel algo order ${algoId}:`, err.response?.data?.msg || err.message);
    return false;
  }
}

async function moveStopLossToBreakEven(symbol, entryPrice, side, manualPrice = null) {
  if (process.env.TRADING_ENABLED !== 'true') return false;
  
  try {
    const info = await getExchangeInfo();
    const precision = getSymbolPrecision(symbol, info);
    const isLong = side === 'BUY' || side === 'LONG';
    
    // 1. Cancel semua algo orders lama (SL/TP) untuk symbol ini
    //    lalu pasang ulang SL baru saja
    const algoOrders = await getOpenAlgoOrders(symbol);
    const slAlgoOrders = algoOrders.filter(o => o.type === 'STOP_MARKET');
    
    for (const order of slAlgoOrders) {
      await cancelAlgoOrder(symbol, order.algoId);
      console.log(`[trade] SL Algo Lama Dibatalkan: ${symbol} (${order.algoId})`);
    }

    // Juga coba cancel dari standard orders (backward compatibility)
    const openOrders = await getBinanceOpenOrders(symbol);
    const slStdOrders = openOrders.filter(o => o.type === 'STOP_MARKET');
    for (const order of slStdOrders) {
      await fetchSigned('DELETE', '/fapi/v1/order', { symbol, orderId: order.orderId }).catch(() => {});
    }
    
    // 2. Hitung harga SL baru
    let finalBePrice;
    if (manualPrice !== null) {
      finalBePrice = parseFloat(parseFloat(manualPrice).toFixed(precision.price));
    } else {
      const bePrice = isLong ? entryPrice * 1.001 : entryPrice * 0.999;
      finalBePrice = parseFloat(bePrice.toFixed(precision.price));
    }
    
    // 3. Pasang SL Baru via Algo Order API
    await placeAlgoOrder({
      symbol,
      side: isLong ? 'SELL' : 'BUY',
      type: 'STOP_MARKET',
      triggerPrice: finalBePrice,
      closePosition: 'true',
      workingType: 'MARK_PRICE'
    });
    
    console.log(`[trade] SL Moved to Break-Even: ${symbol} @ ${finalBePrice}`);
    await sendTelegramMessage(`🛡️ *SL PLUS ACTIVATED: ${symbol}* 🛡️\n\nStop Loss telah digeser ke harga Entry (${finalBePrice}) untuk mengunci keuntungan. Trade ini sekarang aman dari kerugian (Risk-Free)!`);
    return true;
  } catch (err) {
    console.error(`[trade] Gagal menggeser SL ke Break-Even ${symbol}:`, err.response?.data?.msg || err.message);
    return false;
  }
}

/**
 * PRO: Fetch account balance (cached 60 detik)
 */
async function getAccountBalance() {
  const now = Date.now();
  if (cachedBalance !== null && (now - lastBalanceFetch < 60000)) {
    return cachedBalance;
  }
  try {
    const account = await fetchSigned('GET', '/fapi/v2/account');
    const usdtAsset = account.assets.find(a => a.asset === 'USDT');
    cachedBalance = usdtAsset ? parseFloat(usdtAsset.availableBalance) : 0;
    lastBalanceFetch = now;
    return cachedBalance;
  } catch (err) {
    console.error('[balance] Gagal ambil balance:', err.message);
    return cachedBalance || parseFloat(process.env.TRADE_QUANTITY_USDT) * 10; // Fallback
  }
}

/**
 * PRO: Session Filter — Cek apakah saat ini session yang layak trading
 * Skip Asian low-vol (UTC 21:00-01:00) kecuali BTC/ETH
 */
function isGoodTradingSession(symbol) {
  const utcHour = new Date().getUTCHours();
  // Major pairs (BTC/ETH) boleh trading 24/7
  const majorPairs = new Set(['BTCUSDT', 'ETHUSDT', 'BNBUSDT']);
  if (majorPairs.has(symbol)) return true;
  // Altcoins: skip dead zone (UTC 21-01 = low liquidity Asia late night)
  if (utcHour >= 21 || utcHour < 1) {
    return false;
  }
  return true;
}

async function executeBinanceTrade(signalData, netPnL = null) {
  if (process.env.TRADING_ENABLED !== 'true' || !BINANCE_API_KEY || !BINANCE_SECRET_KEY) {
    return false;
  }

  const settings = loadSettings();
  const currentNetPnL = netPnL !== null ? netPnL : await getNetDailyPnL();
  
  if (currentNetPnL >= settings.daily_pnl_target) {
    console.log(`[trade] Skip auto-trade ${signalData.symbol}: Target profit harian (${settings.daily_pnl_target} USDT) sudah tercapai.`);
    return false;
  }
  
  if (currentNetPnL <= -settings.daily_loss_limit) {
    console.log(`[trade] Skip auto-trade ${signalData.symbol}: Limit kerugian harian (-${settings.daily_loss_limit} USDT) sudah terlampaui.`);
    return false;
  }

  // PRO #2: Consecutive Loss Protection — pause setelah N loss berturut
  const maxConsecLoss = settings.max_consecutive_losses || 3;
  if (consecutiveLosses >= maxConsecLoss) {
    console.log(`[risk] ⛔ SKIP ${signalData.symbol}: ${consecutiveLosses} consecutive losses (max: ${maxConsecLoss}). Bot pause 30 menit.`);
    await sendTelegramMessage(`⛔ *BOT AUTO-PAUSE* ⛔\n\n${consecutiveLosses} loss berturut-turut terdeteksi.\nBot berhenti trading selama 30 menit untuk mencegah tilt.\n\n_Reset otomatis setelah win atau 30 menit._`);
    // Auto-reset setelah 30 menit
    setTimeout(() => {
      if (consecutiveLosses >= maxConsecLoss) {
        consecutiveLosses = Math.max(0, maxConsecLoss - 1); // Reduce by 1, bukan full reset
        console.log(`[risk] Auto-resume: consecutiveLosses dikurangi ke ${consecutiveLosses}`);
      }
    }, 30 * 60 * 1000);
    return false;
  }

  const { symbol, signal, price } = signalData;

  // PRO #4: Session Filter — Skip low liquidity hours untuk altcoins
  if (!isGoodTradingSession(symbol)) {
    console.log(`[session] Skip ${symbol}: Low-liquidity session (UTC ${new Date().getUTCHours()}:00)`);
    return false;
  }

  const TRADFI_SYMBOLS = new Set(['XAUUSDT', 'XAGUSDT', 'XPTUSDТ', 'WBETHUSDT']);
  if (TRADFI_SYMBOLS.has(symbol)) {
    console.log(`[trade] Skip auto-trade ${symbol}: Simbol TradFi-Perps.`);
    return false;
  }

  const side = signal.signal.includes('LONG') ? 'BUY' : 'SELL';
  const oppositeSide = side === 'BUY' ? 'SELL' : 'BUY';
  const leverage = parseInt(process.env.DEFAULT_LEVERAGE) || 20;

  try {
    const info = await getExchangeInfo();
    const precision = getSymbolPrecision(symbol, info);
    
    // FIX #8: Spread Filter — cek bid-ask spread sebelum entry
    // Spread lebar = slippage tinggi = loss dari awal
    try {
      const orderbook = await safeGet('/fapi/v1/depth', { symbol, limit: 5 });
      if (orderbook?.data?.bids?.length && orderbook?.data?.asks?.length) {
        const bestBid = parseFloat(orderbook.data.bids[0][0]);
        const bestAsk = parseFloat(orderbook.data.asks[0][0]);
        const spreadPct = ((bestAsk - bestBid) / bestBid) * 100;
        if (spreadPct > 0.1) {
          console.log(`[trade] Skip ${symbol}: spread terlalu lebar (${spreadPct.toFixed(3)}% > 0.1%)`);
          return false;
        }
      }
    } catch (spreadErr) {
      console.warn(`[trade] Spread check gagal untuk ${symbol}: ${spreadErr.message} (lanjut tanpa filter)`);
    }
    
    // PRO #1: Dynamic Position Sizing — Risk % dari balance, bukan flat amount
    const balance = await getAccountBalance();
    const riskPct = settings.risk_per_trade_pct || 1.5; // Default 1.5% akun per trade
    const riskAmount = balance * (riskPct / 100); // Jumlah USDT yang boleh hilang
    
    // Hitung SL distance untuk position sizing
    const slDistance = Math.abs(signal.levels.entry - signal.levels.sl);
    const slPct = (slDistance / signal.levels.entry) * 100;
    
    // Position size = riskAmount / slPct * 100 / leverage → margin yang dibutuhkan
    let usdtAmount;
    if (slPct > 0 && slDistance > 0) {
      // Qty in coins = riskAmount / slDistance
      // Margin = (qty * entry) / leverage
      const qtyFromRisk = riskAmount / slDistance;
      usdtAmount = Math.min(
        (qtyFromRisk * signal.levels.entry) / leverage,
        balance * 0.15 // Hard cap: max 15% balance per trade
      );
    } else {
      usdtAmount = parseFloat(process.env.TRADE_QUANTITY_USDT) || 10;
    }
    
    // PRO #2: Reduce size after consecutive losses
    if (consecutiveLosses > 0) {
      const sizeReduction = Math.pow(0.7, consecutiveLosses); // 70% per loss (1L=70%, 2L=49%)
      const originalAmount = usdtAmount;
      usdtAmount = usdtAmount * sizeReduction;
      console.log(`[risk] Size reduced: $${originalAmount.toFixed(2)} → $${usdtAmount.toFixed(2)} (${consecutiveLosses} losses, ${(sizeReduction*100).toFixed(0)}%)`);
    }
    
    // Minimum margin check
    usdtAmount = Math.max(usdtAmount, 5); // Minimum $5
    
    console.log(`[trade] ${symbol} (${side}) | Balance: $${balance.toFixed(2)} | Risk: ${riskPct}% ($${riskAmount.toFixed(2)}) | Margin: $${usdtAmount.toFixed(2)} | SL: ${slPct.toFixed(2)}%`);

    // 1. Set Leverage
    const currentLev = leverageCache.get(symbol);
    if (currentLev !== leverage) {
      const levParams = signRequest({ symbol, leverage });
      await tradingApi.post('/fapi/v1/leverage', levParams).catch(e => console.warn(`[trade] Skip leverage set: ${e.message}`));
      leverageCache.set(symbol, leverage);
    }

    // 2. Entry Guard (slippage protection)
    try {
      const livePrice = signal.price || price;
      const signalEntry = parseFloat(signal.levels.entry);
      const diff = Math.abs((livePrice - signalEntry) / signalEntry) * 100;
      if (diff > 0.3) { // PRO: Ketat 0.3% (bukan 0.5%) — kurangi slippage
        console.log(`[entry-guard] SKIP ${symbol}: Harga lari ${diff.toFixed(2)}% (max 0.3%)`);
        return false;
      }
      signal.levels.entry = livePrice;
    } catch (e) {
      console.error(`[entry-guard] Skip check due to error:`, e.message);
    }

    // 3. Hitung Quantity
    const qty = (usdtAmount * leverage) / signal.levels.entry;
    const formattedQty = qty.toFixed(precision.quantity);
    
    // PRO #3: LIMIT Order dengan slippage cap (bukan MARKET)
    // Price = entry ± 0.05% buffer agar pasti fill, tapi capped
    const limitBuffer = signal.levels.entry * 0.0005; // 0.05% buffer
    const limitPrice = side === 'BUY' 
      ? (signal.levels.entry + limitBuffer).toFixed(precision.price)
      : (signal.levels.entry - limitBuffer).toFixed(precision.price);
    
    const orderParams = signRequest({
      symbol,
      side,
      type: 'LIMIT',
      quantity: formattedQty,
      price: limitPrice,
      timeInForce: 'IOC' // Immediate-Or-Cancel: fill sekarang atau batal
    });
    
    const mainOrder = await tradingApi.post('/fapi/v1/order', orderParams);
    const executedQty = parseFloat(mainOrder.data.executedQty || mainOrder.data.origQty);
    
    // Cek apakah order ter-fill (IOC bisa partially fill atau cancel)
    if (executedQty <= 0) {
      console.log(`[trade] LIMIT IOC tidak ter-fill untuk ${symbol}. Skip.`);
      return false;
    }
    
    console.log(`[trade] Entry via LIMIT IOC! Order: ${mainOrder.data.orderId} | Filled: ${executedQty} | Price: ${limitPrice}`);

    // 🔥 SAFETY DELAY: Tunggu 500ms agar Binance Testnet sinkron sebelum pasang TP/SL
    await sleep(500);

    // 4. TP & SL (MENGGUNAKAN STANDAR ORDER)
    // Jika Signal memiliki levels, pasang TP/SL
    if (signal.levels) {
      const tpPrice = parseFloat(signal.levels.tp2).toFixed(precision.price);
      const slPrice = parseFloat(signal.levels.sl).toFixed(precision.price);
      
      // Simpan rincian trade untuk tracking partial TP
      const tradeData = {
        symbol,
        type: signal.signal.includes('LONG') ? 'LONG' : 'SHORT',
        entry: parseFloat(signal.levels.entry),
        initialQty: executedQty,
        precision: precision,
        margin: usdtAmount,
        leverage: leverage,
        tp1: parseFloat(signal.levels.tp1),
        tp2: parseFloat(signal.levels.tp2),
        tp3: parseFloat(signal.levels.tp3),
        sl: parseFloat(signal.levels.sl),
        isPartiallyClosed: false,
        hitTp1: false,
        hitTp2: false,
        last_pnl_step: 0,
        timestamp: Date.now()
      };

        try {
          // TP Order (Take Profit Market) via Algo API
          await placeAlgoOrder({
            symbol,
            side: oppositeSide,
            type: 'TAKE_PROFIT_MARKET',
            triggerPrice: tpPrice,
            closePosition: 'true',
            workingType: 'MARK_PRICE'
          });
          console.log(`[trade] TP Terpasang (Algo): TP2 @ ${tpPrice}`);
        } catch (tpErr) {
          const errMsg = tpErr.response?.data?.msg || tpErr.message;
          const errCode = tpErr.response?.data?.code || 'N/A';
          console.error(`[trade] Gagal pasang TP ${symbol} (${errCode}):`, errMsg);
          await sendTelegramMessage(`⚠️ *Gagal Pasang TP ${symbol}* (Code: ${errCode})\n\nError: ${errMsg}\nParams: side=${oppositeSide}, price=${tpPrice}`);
        }

        try {
          // SL Order (Stop Market) via Algo API
          await placeAlgoOrder({
            symbol,
            side: oppositeSide,
            type: 'STOP_MARKET',
            triggerPrice: slPrice,
            closePosition: 'true',
            workingType: 'MARK_PRICE'
          });
          console.log(`[trade] SL Terpasang (Algo): SL @ ${slPrice}`);
        } catch (slErr) {
          const errMsg = slErr.response?.data?.msg || slErr.message;
          const errCode = slErr.response?.data?.code || 'N/A';
          console.error(`[trade] Gagal pasang SL ${symbol} (${errCode}):`, errMsg);
          await sendTelegramMessage(`⚠️ *Gagal Pasang SL ${symbol}* (Code: ${errCode})\n\nError: ${errMsg}\nParams: side=${oppositeSide}, price=${slPrice}`);
        }


        await sendTelegramMessage(`🚀 *AUTO-TRADE EXECUTED* 🚀\n\nKoin: ${symbol}\nTipe: ${side}\nLeverage: ${leverage}x\nEntry: ${price}\nTP2: ${tpPrice}\nSL: ${slPrice}\n\n_Eksekusi Berhasil!_`);
        
        // Simpan ke database lokal setelah TP/SL terpasang
        const activeTrades = loadActiveTrades();
        activeTrades[symbol] = tradeData;
        saveActiveTrades(activeTrades);
      } else {
        await sendTelegramMessage(`🚀 *AUTO-TRADE EXECUTED (No TP/SL)* 🚀\n\nKoin: ${symbol}\nTipe: ${side}\nLeverage: ${leverage}x\nEntry: ${price}\n\n_Eksekusi Berhasil! Bot akan memantau via Self-Healing._`);
        
        // Simpan dasar saja jika TP/SL gagal (agar tetap terlacak)
        const activeTrades = loadActiveTrades();
        activeTrades[symbol] = tradeData;
        saveActiveTrades(activeTrades);
      }

      return true; // Berhasil Entry = Berhasil Trade (Lacak agar tidak lebih dari 5)
    } catch (err) {
    const msg = err.response?.data?.msg || err.message;
    const errCode = err.response?.data?.code;
    const fullError = JSON.stringify(err.response?.data || {});

    // Deteksi error Agreement TradFi-Perps dari Binance
    if (msg && msg.toLowerCase().includes('tradfi') || msg.toLowerCase().includes('agreement') || errCode === -4185) {
      console.warn(`[trade] Skip ${symbol}: Perlu sign TradFi-Perps Agreement di Binance.com terlebih dahulu.`);
      await sendTelegramMessage(`ℹ️ *INFO AUTO-TRADE: ${symbol}*\n\nSimbol ini adalah produk TradFi-Perps (Commodity/Logam).\n\nUntuk mengaktifkan auto-trade, silakan sign agreement di:\nBinance Futures → ${symbol} → Accept Agreement\n\nScanner tetap aktif, sinyal tetap dikirim.`);
      return false;
    }

    console.error(`[trade] Gagal mengeksekusi order ${symbol}:`, msg, fullError);
    await sendTelegramMessage(`⚠️ *AUTO-TRADE FAILED* ⚠️\n\nKoin: ${symbol}\nError: ${msg}`);
    return false;
  }
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error.config;
    const shouldRetry =
      Boolean(config) &&
      (isNetworkError(error) || (error.response?.status >= 500 && error.response?.status < 600));

    if (!shouldRetry) {
      return Promise.reject(normalizeAxiosError(error));
    }

    config.__retryCount = (config.__retryCount || 0) + 1;
    if (config.__retryCount > 2) {
      return Promise.reject(normalizeAxiosError(error));
    }

    if (isNetworkError(error)) {
      rotateBaseUrl();
      config.baseURL = getActiveBaseUrl();
    }

    console.log(
      `[retry] ${config.__retryCount}/2 -> ${buildRequestUrl(config)}`
    );

    await sleep(800 * config.__retryCount);
    return api(config);
  }
);

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;

  // Wilder's Smoothed RSI (standar TradingView/MetaTrader)
  // Step 1: Seed dengan SMA dari period pertama
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta > 0) avgGain += delta;
    else avgLoss += Math.abs(delta);
  }
  avgGain /= period;
  avgLoss /= period;

  // Step 2: Wilder's smoothing (EMA with alpha = 1/period)
  for (let i = period + 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? Math.abs(delta) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
}

function calcEMA(closes, period) {
  if (closes.length < period) return closes[closes.length - 1] || 0;

  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((sum, value) => sum + value, 0) / period;

  for (let i = period; i < closes.length; i += 1) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }

  return ema;
}

function calcMACD(closes) {
  if (closes.length < 35) return { macd: 0, signal: 0, histogram: 0, prevHistogram: 0 };

  const macdSeries = [];
  for (let i = 26; i <= closes.length; i += 1) {
    const slice = closes.slice(0, i);
    macdSeries.push(calcEMA(slice, 12) - calcEMA(slice, 26));
  }

  const macdLine = macdSeries[macdSeries.length - 1];
  const signalLine = macdSeries.length >= 9 ? calcEMA(macdSeries, 9) : macdLine * 0.85;

  const prevMacdLine = macdSeries[macdSeries.length - 2];
  const prevSignalLine = macdSeries.length >= 10 ? calcEMA(macdSeries.slice(0, -1), 9) : prevMacdLine * 0.85;

  return {
    macd: parseFloat(macdLine.toFixed(8)),
    signal: parseFloat(signalLine.toFixed(8)),
    histogram: parseFloat((macdLine - signalLine).toFixed(8)),
    prevHistogram: parseFloat((prevMacdLine - prevSignalLine).toFixed(8)),
  };
}

function calcBB(closes, period = 20) {
  if (closes.length < period) return { upper: 0, middle: 0, lower: 0, width: 0 };

  const window = closes.slice(-period);
  const middle = window.reduce((sum, value) => sum + value, 0) / period;
  const stdDev = Math.sqrt(
    window.reduce((sum, value) => sum + Math.pow(value - middle, 2), 0) / period
  );
  const upper = middle + 2 * stdDev;
  const lower = middle - 2 * stdDev;

  return {
    upper,
    middle,
    lower,
    width: parseFloat((((upper - lower) / middle) * 100).toFixed(2)),
  };
}

function calcStochRSI(closes, rsiPeriod = 14, stochPeriod = 14) {
  const rsis = [];
  for (let i = rsiPeriod; i <= closes.length; i += 1) {
    rsis.push(calcRSI(closes.slice(0, i), rsiPeriod));
  }

  if (rsis.length < stochPeriod) return { k: 50, d: 50 };

  const recent = rsis.slice(-stochPeriod);
  const min = Math.min(...recent);
  const max = Math.max(...recent);
  const kValue = max === min ? 50 : ((recent[recent.length - 1] - min) / (max - min)) * 100;

  const kWindow = rsis.slice(-Math.min(rsis.length, stochPeriod + 3));
  const kSeries = [];
  for (let i = stochPeriod - 1; i < kWindow.length; i += 1) {
    const slice = kWindow.slice(i - stochPeriod + 1, i + 1);
    const sliceMin = Math.min(...slice);
    const sliceMax = Math.max(...slice);
    kSeries.push(
      sliceMax === sliceMin ? 50 : ((slice[slice.length - 1] - sliceMin) / (sliceMax - sliceMin)) * 100
    );
  }

  const dValue = kSeries.length >= 3
    ? kSeries.slice(-3).reduce((sum, value) => sum + value, 0) / 3
    : kValue;

  return {
    k: parseFloat(kValue.toFixed(2)),
    d: parseFloat(dValue.toFixed(2)),
  };
}

function calcATR(klines, period = 14) {
  if (klines.length < period + 1) return 0;

  const trueRanges = [];
  for (let i = 1; i < klines.length; i += 1) {
    const high = Number(klines[i][2]);
    const low = Number(klines[i][3]);
    const prevClose = Number(klines[i - 1][4]);
    trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }

  return trueRanges.slice(-period).reduce((sum, value) => sum + value, 0) / period;
}

function calcADX(klines, period = 14) {
  if (klines.length < period * 2) return { adx: 0, plusDI: 0, minusDI: 0 };

  const trs = [];
  const plusDMs = [];
  const minusDMs = [];

  for (let i = 1; i < klines.length; i++) {
    const h = Number(klines[i][2]);
    const l = Number(klines[i][3]);
    const ph = Number(klines[i - 1][2]);
    const pl = Number(klines[i - 1][3]);
    const pc = Number(klines[i - 1][4]);

    const tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    trs.push(tr);

    const upMove = h - ph;
    const downMove = pl - l;

    if (upMove > downMove && upMove > 0) plusDMs.push(upMove);
    else plusDMs.push(0);

    if (downMove > upMove && downMove > 0) minusDMs.push(downMove);
    else minusDMs.push(0);
  }

  const smoothRange = (arr, p) => {
    let prev = arr.slice(0, p).reduce((a, b) => a + b, 0);
    const smoothed = [prev];
    for (let i = p; i < arr.length; i++) {
      prev = prev - (prev / p) + arr[i];
      smoothed.push(prev);
    }
    return smoothed;
  };

  const sTR = smoothRange(trs, period);
  const sPlusDM = smoothRange(plusDMs, period);
  const sMinusDM = smoothRange(minusDMs, period);

  const dxs = [];
  for (let i = 0; i < sTR.length; i++) {
    const plusDI = (sPlusDM[i] / sTR[i]) * 100;
    const minusDI = (sMinusDM[i] / sTR[i]) * 100;
    const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
    dxs.push({ dx, plusDI, minusDI });
  }

  let adxValue = dxs.slice(0, period).reduce((s, x) => s + x.dx, 0) / period;
  for (let i = period; i < dxs.length; i++) {
    adxValue = (adxValue * (period - 1) + dxs[i].dx) / period;
  }

  const last = dxs[dxs.length - 1];
  return {
    adx: parseFloat(adxValue.toFixed(2)),
    plusDI: parseFloat(last.plusDI.toFixed(2)),
    minusDI: parseFloat(last.minusDI.toFixed(2))
  };
}

function calcVWAP(klines) {
  let volumePrice = 0;
  let volume = 0;

  klines.forEach((kline) => {
    const typicalPrice = (Number(kline[2]) + Number(kline[3]) + Number(kline[4])) / 3;
    const currentVolume = Number(kline[5]);
    volumePrice += typicalPrice * currentVolume;
    volume += currentVolume;
  });

  return volume === 0 ? 0 : volumePrice / volume;
}

// ─────────────────────────────────────────────────────────────────────
// 🎯 MULTI-TIMEFRAME CONFIRMATION (Reduces False Signals)
// ─────────────────────────────────────────────────────────────────────
async function confirmMultiTimeframe(symbol, targetTrend) {
  try {
    // Fetch 5m, 15m, 1h signals in parallel
    const [signal5m, signal15m, signal1h] = await Promise.all([
      analyzePair(symbol, '5m').catch(e => null),
      analyzePair(symbol, '15m').catch(e => null),
      analyzePair(symbol, '1h').catch(e => null)
    ]);

    const signals = [signal5m, signal15m, signal1h].filter(s => s && !s.skip && s.signal);
    if (signals.length < 2) return { confirmationScore: 0, consensus: 'WEAK' }; // Need at least 2 TFs

    // Count agreements with target trend (LONG/SHORT)
    const isLong = targetTrend === 'LONG';
    const agreements = signals.filter(s => {
      const isBullish = s.signal.signal.includes('LONG');
      return isLong === isBullish;
    }).length;

    const consensus = agreements >= 2 ? 'STRONG' : 'WEAK';
    const confirmationScore = agreements; // 0-3 scale

    return { confirmationScore, consensus, agreements, total: signals.length };
  } catch (e) {
    console.warn(`[mtf] Multi-TF confirmation failed for ${symbol}: ${e.message}`);
    return { confirmationScore: 0, consensus: 'UNKNOWN' };
  }
}

// ─────────────────────────────────────────────────────────────────────
// 🎯 CORRELATION FILTER (Prevent Correlated Pair Clustering)
// ─────────────────────────────────────────────────────────────────────
function getCorrelatedPairs(symbol) {
  // Define correlation baskets: pairs that move together
  const correlationMap = {
    'BTCUSDT': ['ETHUSDT', 'BNBUSDT', 'LTCUSDT'],      // Bitcoin basket
    'ETHUSDT': ['BTCUSDT', 'BNBUSDT', 'SOLUSDT', 'MATICUSDT'], // Ethereum basket
    'BNBUSDT': ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],      // Binance Coin basket
    'SOLUSDT': ['ETHUSDT', 'BNBUSDT'],                  // Solana basket
    'MATICUSDT': ['ETHUSDT'],                            // Polygon (ETH L2)
    'LTCUSDT': ['BTCUSDT'],                              // Litecoin (legacy BTC)
    'XRPUSDT': [],                                       // XRP independent
    'ADAUSDT': [],                                       // ADA independent
    'DOTUSDT': [],                                       // DOT independent
    'TRXUSDT': []                                        // TRX independent
  };
  return correlationMap[symbol] || [];
}

function checkCorrelationConflict(symbol, activeTrades) {
  const correlatedPairs = getCorrelatedPairs(symbol);
  for (const pair of correlatedPairs) {
    if (activeTrades[pair]) {
      const trade = activeTrades[pair];
      // Only skip if trade type is same (don't hedge same direction)
      if (trade.type === 'LONG' || trade.type === 'SHORT') {
        return { conflict: true, conflictPair: pair, conflictType: trade.type };
      }
    }
  }
  return { conflict: false };
}

// ─────────────────────────────────────────────────────────────────────
// 🎯 MARKET REGIME DETECTION (Trend Strength Confirmation)
// ─────────────────────────────────────────────────────────────────────
function detectMarketRegime(klines, ema20, ema50, ema200, price, bb) {
  if (klines.length < 50) {
    return { regime: 'UNKNOWN', strength: 0 };
  }

  const closes = klines.map(k => parseFloat(k[4]));
  const highs = klines.map(k => parseFloat(k[2]));
  const lows = klines.map(k => parseFloat(k[3]));

  // Count candles in uptrend (higher close than open)
  let uptrendCandles = 0;
  for (let i = Math.max(0, closes.length - 20); i < closes.length; i++) {
    const open = parseFloat(klines[i][1]);
    if (closes[i] > open) uptrendCandles++;
  }

  const uptrendPercent = uptrendCandles / 20;

  // Regime classification
  let regime = 'CHOP';
  let strength = 0;

  if (price > ema20 && ema20 > ema50 && ema50 > ema200 && uptrendPercent > 0.6) {
    // Strong uptrend: All EMAs stacked bullish + >60% up candles
    regime = 'STRONG_UP';
    strength = Math.min(10, Math.round(uptrendPercent * 10));
  } else if (price > ema50 && ema20 > ema50 && uptrendPercent > 0.55) {
    // Mild uptrend
    regime = 'MILD_UP';
    strength = 6;
  } else if (price < ema20 && ema20 < ema50 && ema50 < ema200 && uptrendPercent < 0.4) {
    // Strong downtrend: All EMAs stacked bearish + <40% up candles
    regime = 'STRONG_DOWN';
    strength = Math.min(10, Math.round((1 - uptrendPercent) * 10));
  } else if (price < ema50 && ema20 < ema50 && uptrendPercent < 0.45) {
    // Mild downtrend
    regime = 'MILD_DOWN';
    strength = 6;
  } else {
    // Choppy consolidation
    regime = 'CHOP';
    strength = 0;
  }

  return { regime, strength, uptrendPercent };
}

// ─────────────────────────────────────────────────────────────────────
// 🎯 PHASE 3: ADVANCED PATTERN RECOGNITION
// ─────────────────────────────────────────────────────────────────────
function detectConsolidationPattern(klines) {
  if (klines.length < 20) return { pattern: 'NONE', strength: 0 };

  const closes = klines.slice(-20).map(k => parseFloat(k[4]));
  const highs = klines.slice(-20).map(k => parseFloat(k[2]));
  const lows = klines.slice(-20).map(k => parseFloat(k[3]));

  const maxHigh = Math.max(...highs);
  const minLow = Math.min(...lows);
  const range = maxHigh - minLow;

  // Consolidation: narrow range (< 2% of current price)
  const currentPrice = closes[closes.length - 1];
  const rangePercent = (range / currentPrice) * 100;

  if (rangePercent < 2.5) {
    // Count candles in range - if >80% are in upper half, breakout UP likely
    const upperHalf = closes.filter(c => c > (minLow + range / 2)).length;
    const breakoutDirection = upperHalf > 16 ? 'UP' : 'DOWN';
    return { 
      pattern: 'CONSOLIDATION', 
      strength: 7,  // +7 bonus for tight range breakouts
      direction: breakoutDirection,
      rangePercent 
    };
  }

  // Ascending Triangle: highs stable, lows rising
  const last5Highs = highs.slice(-5);
  const last10Lows = lows.slice(-10);
  const highsStable = Math.max(...last5Highs) - Math.min(...last5Highs) < range * 0.1;
  const lowsRising = last10Lows[9] > last10Lows[0];

  if (highsStable && lowsRising) {
    return { pattern: 'ASCENDING_TRIANGLE', strength: 6, direction: 'UP' };
  }

  // Descending Triangle: lows stable, highs falling
  const last5Lows = lows.slice(-5);
  const last10Highs = highs.slice(-10);
  const lowsStable = Math.max(...last5Lows) - Math.min(...last5Lows) < range * 0.1;
  const highsFalling = last10Highs[9] < last10Highs[0];

  if (lowsStable && highsFalling) {
    return { pattern: 'DESCENDING_TRIANGLE', strength: 6, direction: 'DOWN' };
  }

  return { pattern: 'NONE', strength: 0 };
}

// ─────────────────────────────────────────────────────────────────────
// 🎯 PHASE 3: VOLUME BREAKOUT VALIDATION
// ─────────────────────────────────────────────────────────────────────
function validateVolumeBreakout(klines, srLevels) {
  if (klines.length < 20) return { volumeValid: false, ratio: 0 };

  const volumes = klines.map(k => parseFloat(k[5]));
  const currentVolume = volumes[volumes.length - 1];
  const avgVolume = volumes.slice(-20, -1).reduce((s, v) => s + v, 0) / 19;

  // Volume ratio: current vs average
  const volumeRatio = currentVolume / avgVolume;

  // High volume required for breakouts (>1.5x average)
  let volumeValid = volumeRatio > 1.5;

  // STRONGER: If actually breaking out of resistance, accept lower volume ratio
  if (srLevels.breakoutResistance || srLevels.breakoutSupport) {
    volumeValid = volumeRatio > 1.3;  // Relaxed to 1.3x if confirmed breakout
  }

  return { 
    volumeValid, 
    ratio: parseFloat(volumeRatio.toFixed(2)), 
    currentVolume,
    avgVolume 
  };
}

// ─────────────────────────────────────────────────────────────────────
// 🎯 PHASE 3: MOMENTUM CONFIRMATION (RSI + MACD Alignment)
// ─────────────────────────────────────────────────────────────────────
function confirmMomentumAlignment(rsi, macd, stochRSI) {
  let score = 0;
  const signals = [];

  // RSI confirmation
  const rsiOversold = rsi < 30;
  const rsiOverbought = rsi > 70;
  const rsiNeutral = rsi >= 40 && rsi <= 60;

  // MACD confirmation
  const macdBullish = macd.macd > macd.signal;
  const macdBearish = macd.macd < macd.signal;

  // Stoch RSI confirmation
  const stochBullish = stochRSI.k < 20;  // About to cross up
  const stochBearish = stochRSI.k > 80;  // About to cross down

  // Bullish alignment
  if ((rsiOversold && macdBullish) || (rsiNeutral && macdBullish && stochBullish)) {
    score += 3;
    signals.push('Bullish momentum');
  }

  // Bearish alignment
  if ((rsiOverbought && macdBearish) || (rsiNeutral && macdBearish && stochBearish)) {
    score -= 3;
    signals.push('Bearish momentum');
  }

  // Weak signals
  if (!rsiOversold && !rsiOverbought && macdBullish && stochBullish) {
    score += 1.5;
    signals.push('Mild bullish');
  }

  return { 
    alignment: score !== 0 ? (score > 0 ? 'BULLISH' : 'BEARISH') : 'NEUTRAL',
    score,
    signals,
    strength: Math.abs(score)
  };
}

// ─────────────────────────────────────────────────────────────────────
// 🎯 PHASE 3: DYNAMIC POSITION SIZING (Risk Management)
// ─────────────────────────────────────────────────────────────────────
function calculateDynamicPositionSize(atr, balance, riskPercentage = 1.0, currentPrice) {
  if (!atr || atr <= 0 || !balance || balance <= 0) {
    return { size: 0, riskAmount: 0, positionRatio: 0 };
  }

  // Risk amount based on account balance
  const riskAmount = balance * (riskPercentage / 100);

  // Position size = risk / (SL distance)
  // SL distance ~= 2 * ATR for moderate-leverage trading
  const slDistance = 2 * atr;
  const size = riskAmount / slDistance;
  const positionRatio = (size * currentPrice) / balance;  // Target % of balance

  return {
    size: parseFloat(size.toFixed(4)),
    riskAmount: parseFloat(riskAmount.toFixed(2)),
    positionRatio: parseFloat(positionRatio.toFixed(2)),
    slDistance: parseFloat(slDistance.toFixed(6))
  };
}

// ─────────────────────────────────────────────────────────────────────
// 🎯 DIVERGENCE DETECTION (Highest Probability Setups)
// ─────────────────────────────────────────────────────────────────────
function detectDivergence(closes, rsis, macds, prices) {
  if (closes.length < 10 || rsis.length < 10) {
    return { bullishDiv: false, bearishDiv: false, confidence: 0 };
  }

  // Proper swing high/low detection (minimum 3-candle pivot)
  // Cari 2 swing low terakhir untuk bullish div, 2 swing high untuk bearish div
  const len = Math.min(prices.length, rsis.length);
  const swingLows = [];
  const swingHighs = [];

  for (let i = 2; i < len - 1; i++) {
    // Swing low: price[i] lower than both neighbors
    if (prices[i] < prices[i - 1] && prices[i] < prices[i + 1] &&
        prices[i] < prices[i - 2]) {
      swingLows.push({ idx: i, price: prices[i], rsi: rsis[i] });
    }
    // Swing high: price[i] higher than both neighbors
    if (prices[i] > prices[i - 1] && prices[i] > prices[i + 1] &&
        prices[i] > prices[i - 2]) {
      swingHighs.push({ idx: i, price: prices[i], rsi: rsis[i] });
    }
  }

  let bullishDiv = false, bearishDiv = false;
  let divStrength = 0;

  // Regular Bullish Divergence: price lower low + RSI higher low (di area oversold)
  if (swingLows.length >= 2) {
    const prev = swingLows[swingLows.length - 2];
    const curr = swingLows[swingLows.length - 1];
    if (curr.price < prev.price && curr.rsi > prev.rsi && curr.rsi < 45) {
      bullishDiv = true;
      divStrength = (curr.rsi - prev.rsi) * 1.5;
    }
  }

  // Regular Bearish Divergence: price higher high + RSI lower high (di area overbought)
  if (swingHighs.length >= 2) {
    const prev = swingHighs[swingHighs.length - 2];
    const curr = swingHighs[swingHighs.length - 1];
    if (curr.price > prev.price && curr.rsi < prev.rsi && curr.rsi > 55) {
      bearishDiv = true;
      divStrength = (prev.rsi - curr.rsi) * 1.5;
    }
  }

  return {
    bullishDiv,
    bearishDiv,
    confidence: Math.min(100, Math.max(0, divStrength)),
  };
}

// ─────────────────────────────────────────────────────────────────────
// 📍 SUPPORT & RESISTANCE + SWING HIGH/LOW DETECTION (PRO)
// ─────────────────────────────────────────────────────────────────────
function detectSupportResistance(klines, period = 20) {
  if (klines.length < period) {
    return { support: 0, resistance: 0, isBreakout: false, swingLow: 0, swingHigh: 0 };
  }

  const highs = klines.slice(-period).map(k => Number(k[2]));
  const lows = klines.slice(-period).map(k => Number(k[3]));
  const currentPrice = Number(klines[klines.length - 1][4]);

  const resistance = Math.max(...highs);
  const support = Math.min(...lows);

  // PRO: Detect actual swing high/low (pivot points) — last 10 candles
  // Swing Low = candle whose low is lower than both neighbors
  // Swing High = candle whose high is higher than both neighbors
  let swingLow = support;
  let swingHigh = resistance;
  const lookback = Math.min(10, klines.length - 2);
  for (let i = klines.length - lookback; i < klines.length - 1; i++) {
    const h = Number(klines[i][2]);
    const l = Number(klines[i][3]);
    const prevH = Number(klines[i - 1][2]);
    const prevL = Number(klines[i - 1][3]);
    const nextH = Number(klines[i + 1][2]);
    const nextL = Number(klines[i + 1][3]);
    if (l < prevL && l < nextL) swingLow = Math.max(swingLow, l); // Nearest swing low
    if (h > prevH && h > nextH) swingHigh = Math.min(swingHigh, h); // Nearest swing high
  }

  const isBreakoutResistance = currentPrice > resistance * 1.005;
  const isBreakoutSupport = currentPrice < support * 0.995;

  return {
    support,
    resistance,
    swingLow,
    swingHigh,
    breakoutResistance: isBreakoutResistance,
    breakoutSupport: isBreakoutSupport,
    isNearSupport: currentPrice < support * 1.02,
    isNearResistance: currentPrice > resistance * 0.98,
  };
}

// ─────────────────────────────────────────────────────────────────────
// 🎲 ADAPTIVE TP/SL — AUTO-DETECT MODE DARI INTERVAL
// Hybrid 15m: SL 1.2x ATR, TP1 1.0x, TP2 1.8x, TP3 2.5x (R:R ~1:1.8)
// Scalp 5m:   SL 1.0x ATR, TP1 0.8x, TP2 1.5x, TP3 2.2x (R:R ~1:1.5)
// Swing 1h:   SL 1.5x ATR, TP1 1.2x, TP2 2.0x, TP3 3.0x (R:R ~1:2)
// ─────────────────────────────────────────────────────────────────────
function calculateOptimalTPSL(entry, atr, trend, support, resistance, mode = 'swing', swingLow = 0, swingHigh = 0) {
  const isLong = trend === 'long' || trend === 'bullish';

  // FIX: TP1 HARUS SELALU > SL distance agar setiap trade net positive
  // Prinsip: SL ketat, TP jauh → positive expectancy
  const params = {
    scalp:  { sl: 0.8, tp1: 1.0, tp2: 1.8, tp3: 2.5, rr: 1.25 },
    hybrid: { sl: 1.0, tp1: 1.3, tp2: 2.2, tp3: 3.0, rr: 1.3 },
    swing:  { sl: 1.2, tp1: 1.5, tp2: 2.5, tp3: 3.5, rr: 1.25 }
  };
  const p = params[mode] || params.hybrid;

  if (isLong) {
    // SL: pilih yang paling protektif — ATR-based atau structure (swing low)
    const atrSl = entry - atr * p.sl;
    const structureSl = swingLow > 0 ? swingLow * 0.997 : atrSl;
    const sl = Math.max(support, Math.max(atrSl, structureSl));
    const riskDistance = Math.max(entry - sl, atr * 0.4); // Min 0.4 ATR (sedikit lebih lebar)
    // TP dihitung dari riskDistance → guaranteed R:R > 1
    const tp1 = entry + riskDistance * p.tp1;
    const tp2 = entry + riskDistance * p.tp2;
    const tp3 = entry + riskDistance * p.tp3;
    const actualRR = parseFloat(((tp2 - entry) / riskDistance).toFixed(2));
    return { tp1, tp2, tp3, sl, rr: actualRR };
  } else {
    const atrSl = entry + atr * p.sl;
    const structureSl = swingHigh > 0 ? swingHigh * 1.003 : atrSl;
    const sl = Math.min(resistance, Math.min(atrSl, structureSl));
    const riskDistance = Math.max(sl - entry, atr * 0.4);
    const tp1 = entry - riskDistance * p.tp1;
    const tp2 = entry - riskDistance * p.tp2;
    const tp3 = entry - riskDistance * p.tp3;
    const actualRR = parseFloat(((entry - tp2) / riskDistance).toFixed(2));
    return { tp1, tp2, tp3, sl, rr: actualRR };
  }
}

function generateSignal(indicators, price, fundingRate, interval = '1h', customFixedTp = 0, htfTrend = 'NEUTRAL', rvol = 1.0, divergence = {}, srLevels = {}, regime = {}, pattern = {}, momentum = {}, volumeStatus = {}) {
  let score = 0;
  const reasons = [];
  const { rsi, macd, ema20, ema50, ema9, ema21, bb, stochRSI, vwap, atr } = indicators;
  const isScalp = interval === '1m' || interval === '5m' || interval === '15m';

  // ⭐ PHASE 3: PATTERN RECOGNITION BONUS
  if (pattern.pattern === 'CONSOLIDATION' && pattern.strength > 0) {
    score += pattern.strength;  // +7 bonus
    reasons.push(`📦 Consolidation breakout (${pattern.direction})`);
  } else if (pattern.pattern === 'ASCENDING_TRIANGLE') {
    score += 6;
    reasons.push(`📈 Ascending triangle setup`);
  } else if (pattern.pattern === 'DESCENDING_TRIANGLE') {
    score -= 6;
    reasons.push(`📉 Descending triangle setup`);
  }

  // ⭐ PHASE 3: MOMENTUM CONFIRMATION BONUS
  if (momentum.alignment === 'BULLISH' && momentum.strength > 0) {
    score += Math.round(momentum.strength);
    reasons.push(`⚡ Bullish momentum aligned`);
  } else if (momentum.alignment === 'BEARISH' && momentum.strength > 0) {
    score -= Math.round(momentum.strength);
    reasons.push(`⚡ Bearish momentum aligned`);
  }

  // ⭐ PHASE 3: VOLUME BREAKOUT CHECK
  if (!volumeStatus.volumeValid) {
    if (srLevels.breakoutResistance || srLevels.breakoutSupport) {
      score -= 3;  // Penalize breakouts without volume support
      reasons.push(`⚠️ Breakout with low volume (${volumeStatus.ratio}x)`);
    }
  } else if (volumeStatus.ratio > 2.0) {
    score += 1;
    reasons.push(`📊 Strong volume spike (${volumeStatus.ratio}x)`);
  }

  // ⭐ MARKET REGIME FILTER (Phase 2: Strength confirmation)
  if (regime.regime === 'STRONG_UP' && score >= 0) {
    score += 2;  // Bonus for trading WITH the strong trend
    reasons.push(`📊 Strong uptrend regime (+2)`);
  } else if (regime.regime === 'STRONG_DOWN' && score <= 0) {
    score -= 2;  // Bonus for trading WITH the strong downtrend
    reasons.push(`📊 Strong downtrend regime (-2)`);
  } else if (regime.regime === 'CHOP') {
    score -= 1;  // Slight penalty for choppy/sideways market
    reasons.push(`📊 Choppy consolidation (-1)`);
  }

  // 0. RELATIVE VOLUME (RVOL) FILTER
  if (rvol < 1.1) {
    score -= 3;
    reasons.push(`Low volume (RVOL: ${rvol.toFixed(2)})`);
  } else if (rvol > 2.0) {
    score += 2;
    reasons.push(`High volume spike (RVOL: ${rvol.toFixed(2)})`);
  }

  // 1. RSI Logic (Scalping uses RSI 7)
  const rsiVal = indicators.rsi7 || rsi;
  if (rsiVal < 30) {
    score += isScalp ? 4 : 3;
    reasons.push('RSI strongly oversold (< 30)');
  } else if (rsiVal < 40) {
    score += 2;
  } else if (rsiVal > 70) {
    score -= isScalp ? 4 : 3;
    reasons.push('RSI strongly overbought (> 70)');
  } else if (rsiVal > 60) {
    score -= 2;
  }

  // 2. MACD Logic
  if (macd.macd > macd.signal) {
    score += 2;
    if (macd.histogram > macd.prevHistogram) {
      score += 1;
      reasons.push('MACD bullish (Rising momentum)');
    } else {
      reasons.push('MACD bullish crossover');
    }
  } else if (macd.macd < macd.signal) {
    score -= 2;
    if (macd.histogram < macd.prevHistogram) {
      score -= 1;
      reasons.push('MACD bearish (Falling momentum)');
    } else {
      reasons.push('MACD bearish crossover');
    }
  }

  // ⭐ 2.5 DIVERGENCE DETECTION (Highest Probability)
  if (divergence.bullishDiv) {
    score += 5;
    reasons.push(`🔺 Hidden Bullish Divergence (strength: ${divergence.confidence}%)`);
  }
  if (divergence.bearishDiv) {
    score -= 5;
    reasons.push(`🔻 Regular Bearish Divergence (strength: ${divergence.confidence}%)`);
  }

  // ⭐ 2.7 SUPPORT/RESISTANCE BREAKOUT
  if (srLevels.breakoutResistance) {
    score += 4;
    reasons.push(`📈 Breakout above resistance (${srLevels.resistance.toFixed(4)})`);
  }
  if (srLevels.breakoutSupport) {
    score -= 4;
    reasons.push(`📉 Breakdown below support (${srLevels.support.toFixed(4)})`);
  }
  if (srLevels.isNearSupport && score > 0) {
    score += 2;
    reasons.push(`📍 Price near support (bounce play)`);
  }
  if (srLevels.isNearResistance && score < 0) {
    score -= 2;
    reasons.push(`📍 Price near resistance (rejection play)`);
  }

  // 3. TREND FILTER (EMA 200 & EMA 9/21/50)
  const ema200 = indicators.ema200;
  if (ema200) {
    if (price > ema200) {
      score += 2;
      reasons.push('Price above EMA 200 (HTF Bullish)');
    } else {
      score -= 2;
      reasons.push('Price below EMA 200 (HTF Bearish)');
    }
  }

  if (isScalp && ema9 && ema21) {
    if (ema9 > ema21) {
      score += 3;
      reasons.push('EMA9 above EMA21 (Scalper Bullish)');
    } else {
      score -= 3;
      reasons.push('EMA9 below EMA21 (Scalper Bearish)');
    }
  } else {
    if (ema20 > ema50) {
      score += 3;
      reasons.push('EMA20 above EMA50 (Trend Bullish)');
    } else {
      score -= 3;
      reasons.push('EMA20 below EMA50 (Trend Bearish)');
    }
  }

  // 3a. ADX TREND STRENGTH
  const { adx, plusDI, minusDI } = indicators.adxInfo || { adx: 0 };
  let sidewaysPenalty = false;
  
  if (adx > 25) {
    score += 1;
    reasons.push(`Strong trend (ADX: ${adx})`);
    if (plusDI > minusDI) score += 1;
    else score -= 1;
  } else if (adx < 20) {
    // Sideways market — drastis kurangi score agar tidak entry di chop
    score = score * 0.35;
    sidewaysPenalty = true;
    reasons.push(`⚠️ Weak trend / Sideways (ADX: ${adx})`);
  }

  // 🛑 BB Width Hard Skip: pasar terlalu sempit = guaranteed whipsaw
  if (bb.width < 2.5) {
    score = score * 0.3;
    sidewaysPenalty = true;
    reasons.push(`⚠️ BB Width terlalu sempit (${bb.width}% < 2.5%)`);
  }

  // ⭐ PHASE 3: RELATIVE STRENGTH VS BTC (Worth It Detection)
  if (indicators.relativeStrength > 0.5) {
    score += 3;
    reasons.push(`💪 Outperforming BTC (+3)`);
    if (indicators.relativeStrength > 1.5) {
       score += 2;
       reasons.push(`🚀 Strong Relative Strength (+2)`);
    }
  } else if (indicators.relativeStrength < -1.0) {
    score -= 3;
    reasons.push(`⚠️ Underperforming BTC (-3)`);
  }

  // 4. Bollinger Bands
  if (price <= bb.lower) {
    score += 3;
    reasons.push('Price touched lower Bollinger Band');
  } else if (price >= bb.upper) {
    score -= 3;
    reasons.push('Price touched upper Bollinger Band');
  }

  if (bb.width < 5) {
    score += 1;
    reasons.push('Bollinger squeeze');
  }

  if (stochRSI.k < 20 && stochRSI.d < 20) {
    score += 2;
    reasons.push('StochRSI double oversold');
  } else if (stochRSI.k < 20) {
    score += 1;
  } else if (stochRSI.k > 80 && stochRSI.d > 80) {
    score -= 2;
    reasons.push('StochRSI double overbought');
  } else if (stochRSI.k > 80) {
    score -= 1;
  }

  const distanceToVwap = Math.abs(price - vwap);
  const isOverExtended = distanceToVwap > (atr * 2.5);

  if (price > vwap) {
    if (isOverExtended) {
      score -= 3;
      reasons.push('Over-extended above VWAP (Avoid FOMO)');
    } else {
      score += 1;
      reasons.push('Price gently above VWAP');
    }
  } else {
    if (isOverExtended) {
      score += 3;
      reasons.push('Over-extended below VWAP (Avoid FOMO)');
    } else {
      score -= 1;
      reasons.push('Price gently below VWAP');
    }
  }

  if (fundingRate < -0.05) {
    score += 2;
    reasons.push(`Funding strongly negative (${fundingRate.toFixed(4)}%)`);
  } else if (fundingRate < 0) {
    score += 1;
  } else if (fundingRate > 0.1) {
    score -= 2;
    reasons.push(`Funding very high (${fundingRate.toFixed(4)}%)`);
  } else if (fundingRate > 0.05) {
    score -= 1;
  }

  // --- 🔥 HTF TREND ALIGNMENT PENALTY (Reduced for Scalping) ---
  let htfConflict = false;
  const htfPenalty = isScalp ? 3 : 10; // Scalping: penalty kecil, tetap bisa lawan HTF
  if (htfTrend === 'BEARISH' && score > 0) {
    score -= htfPenalty;
    htfConflict = true;
    reasons.push(`HTF Trend Conflict (4h Bearish, -${htfPenalty})`);
  } else if (htfTrend === 'BULLISH' && score < 0) {
    score += htfPenalty;
    htfConflict = true;
    reasons.push(`HTF Trend Conflict (4h Bullish, +${htfPenalty})`);
  }

  let signal = 'NETRAL';
  let strength = 'neutral';
  let confidence = 50;

  if (score >= 9) {
    signal = 'STRONG LONG';
    strength = 'strong-long';
    confidence = Math.min(95, 78 + score);
  } else if (score >= 5) {
    signal = 'LONG';
    strength = 'long';
    confidence = Math.min(85, 58 + score * 2);
  } else if (score >= 2) {
    signal = 'WEAK LONG';
    strength = 'weaklong';
    confidence = Math.min(65, 48 + score * 3);
  } else if (score <= -9) {
    signal = 'STRONG SHORT';
    strength = 'strong-short';
    confidence = Math.min(95, 78 + Math.abs(score));
  } else if (score <= -5) {
    signal = 'SHORT';
    strength = 'short';
    confidence = Math.min(85, 58 + Math.abs(score) * 2);
  } else if (score <= -2) {
    signal = 'WEAK SHORT';
    strength = 'weakshort';
    confidence = Math.min(65, 48 + Math.abs(score) * 3);
  }

  // Cap confidence if sideways trend is detected to prevent auto-trading
  if (sidewaysPenalty) {
    confidence = Math.min(confidence, 60); // Hard cap jauh lebih rendah
  }

  // Hard Cap confidence if HTF conflict exists — relaxed in scalp mode
  if (htfConflict) {
    confidence = Math.min(confidence, isScalp ? 78 : 60);
  }

  const isLong = score >= 0;
  const entry = price;
  
  // 🎯 ADAPTIVE TP/SL — AUTO-DETECT MODE (15m=hybrid, 5m=scalp, 1h=swing)
  const tpslMode = (interval === '1m' || interval === '5m') ? 'scalp' 
                 : (interval === '15m') ? 'hybrid' : 'swing';
  const tpslLevels = calculateOptimalTPSL(
    entry,
    atr,
    isLong ? 'long' : 'short',
    srLevels.support || entry * 0.95,
    srLevels.resistance || entry * 1.05,
    tpslMode,
    srLevels.swingLow || 0,
    srLevels.swingHigh || 0
  );
  
  let tp1 = tpslLevels.tp1;
  let tp2 = tpslLevels.tp2;  // GUARANTEED 1:2 R:R
  let tp3 = tpslLevels.tp3;
  let sl = tpslLevels.sl;
  
  const rr = tpslLevels.rr;

  const formatPrice = (value) => parseFloat(value.toFixed(price > 100 ? 2 : 6));

  return {
    signal,
    strength,
    score,
    confidence: parseFloat(confidence.toFixed(1)),
    reasons: reasons.slice(0, 6),
    htfTrend,
    htfConflict,
    levels: {
      entry: formatPrice(entry),
      tp1: formatPrice(tp1),
      tp2: formatPrice(tp2),
      tp3: formatPrice(tp3),
      sl: formatPrice(sl),
      rr,
    },
  };
}

async function analyzePair(symbol, interval = '1h', full = false, btcStatus = null) {
  try {
    const [klinesRes, klines4hRes, tickerRes, fundingRes] = await Promise.all([
      safeGet('/fapi/v1/klines', { symbol, interval, limit: full ? 200 : 100 }),
      safeGet('/fapi/v1/klines', { symbol, interval: '4h', limit: 200 }),
      safeGet('/fapi/v1/ticker/24hr', { symbol }),
      safeGet('/fapi/v1/premiumIndex', { symbol }),
    ]);

    // Validate responses exist
    if (!klinesRes?.data || !klines4hRes?.data || !tickerRes?.data || !fundingRes?.data) {
      throw new Error(`Invalid API response - missing data for ${symbol}`);
    }

    const klines = klinesRes.data;
    const klines4h = klines4hRes.data;
    const ticker = tickerRes.data;
    const funding = fundingRes.data;

    // 1b. Liquidity Verification (24h Volume)
    if (!USE_TESTNET) {
      const quoteVol24h = parseFloat(ticker.quoteVolume);
      let minVol = parseFloat(process.env.SCANNER_MIN_VOLUME_USDT);
      if (!minVol) {
        minVol = WATCHLIST.length <= 15 ? 1000000 : 50000000;
      }
      if (quoteVol24h < minVol && !full) {
        return { symbol, skip: true, reason: 'LOW_LIQUIDITY' };
      }
    }

    if (!Array.isArray(klines) || klines.length === 0) {
      throw new Error(`No kline data returned for ${symbol}`);
    }

    // Calculate indicator data
    const closes = klines.map((kline) => parseFloat(kline[4]));
    const price = parseFloat(ticker.lastPrice);
    const fundingRate = parseFloat(funding.lastFundingRate) * 100;
    
    // Relative Strength Calculation (vs BTC)
    let relativeStrength = 0;
    if (btcStatus && btcStatus.priceChange15m !== undefined) {
       const coinPrev15m = closes[closes.length - 4] || closes[0];
       const coinPriceChange15m = ((price - coinPrev15m) / coinPrev15m) * 100;
       relativeStrength = coinPriceChange15m - btcStatus.priceChange15m;
    }

    const indicators = {
      rsi: calcRSI(closes),
      rsi7: calcRSI(closes, 7),
      macd: calcMACD(closes),
      ema9: calcEMA(closes, 9),
      ema21: calcEMA(closes, 21),
      ema20: calcEMA(closes, 20),
      ema50: calcEMA(closes, 50),
      ema200: calcEMA(closes, 200),
      bb: calcBB(closes),
      stochRSI: calcStochRSI(closes),
      atr: calcATR(klines),
      adxInfo: calcADX(klines),
      vwap: calcVWAP(klines.slice(-24)),
      relativeStrength // Injecting RS here
    };

    // CALCULATE RELATIVE VOLUME (RVOL)
    const volumes = klines.map(k => parseFloat(k[5]));
    const avgVol = volumes.slice(-21, -1).reduce((s, v) => s + v, 0) / 20;
    const rvol = volumes[volumes.length - 1] / avgVol;

    // HTF TREND ANALYSIS (4h)
    const closes4h = klines4h.map(k => parseFloat(k[4]));
    const ema200_4h = calcEMA(closes4h, 200);
    const htfTrend = price > ema200_4h ? 'BULLISH' : (price < ema200_4h ? 'BEARISH' : 'NEUTRAL');

    // DIVERGENCE DETECTION - Build RSI values array for last 20 candles
    const rsiValues = [];
    for (let i = Math.max(0, closes.length - 20); i < closes.length; i++) {
      rsiValues.push(calcRSI(closes.slice(0, i + 1)));
    }
    
    // Build MACD values array (extract MACD line from each step)
    const macdValues = [];
    for (let i = Math.max(0, closes.length - 20); i < closes.length; i++) {
      const m = calcMACD(closes.slice(0, i + 1));
      macdValues.push(m.macd);
    }
    
    const divergence = detectDivergence(closes.slice(-20), rsiValues, macdValues, closes.slice(-20));

    // SUPPORT/RESISTANCE DETECTION
    const srLevels = detectSupportResistance(klines, 20);

    // ✅ MARKET REGIME DETECTION (Phase 2)
    const regime = detectMarketRegime(klines, indicators.ema20, indicators.ema50, indicators.ema200, price, indicators.bb);

    // ✅ PHASE 3: PATTERN RECOGNITION
    const pattern = detectConsolidationPattern(klines);

    // ✅ PHASE 3: MOMENTUM CONFIRMATION
    const momentum = confirmMomentumAlignment(indicators.rsi, indicators.macd, indicators.stochRSI);

    // ✅ PHASE 3: VOLUME BREAKOUT VALIDATION
    const volumeStatus = validateVolumeBreakout(klines, srLevels);

    const result = {
      symbol,
      price,
      priceChangePercent: parseFloat(ticker.priceChangePercent),
      high24h: parseFloat(ticker.highPrice),
      low24h: parseFloat(ticker.lowPrice),
      volume24h: parseFloat(ticker.volume),
      quoteVolume: parseFloat(ticker.quoteVolume),
      fundingRate,
      markPrice: parseFloat(funding.markPrice),
      stochK: indicators.stochRSI.k,
      htfTrend,
      rvol,
      indicators,
      signal: generateSignal(indicators, price, fundingRate, interval, loadSettings().fixed_tp_usdt, htfTrend, rvol, divergence, srLevels, regime, pattern, momentum, volumeStatus),
    };

    if (full) {
      result.klines = klines.slice(-100).map((kline) => ({
        time: kline[0],
        open: Number(kline[1]),
        high: Number(kline[2]),
        low: Number(kline[3]),
        close: Number(kline[4]),
        volume: Number(kline[5]),
      }));

      try {
        const openInterestRes = await api.get('/fapi/v1/openInterest', { params: { symbol } });
        result.openInterest = parseFloat(openInterestRes.data.openInterest);
      } catch (error) {
        result.openInterest = null;
        console.warn(`[warn] open interest unavailable for ${symbol}: ${normalizeAxiosError(error).message}`);
      }
    }

    return result;

  } catch (err) {
    const status = err.response?.status;
    const code = err.code;
    const msg = err.response?.data?.msg || err.message;
    console.error(`[analyze] Error for ${symbol}: HTTP ${status || code || 'unknown'} - ${msg}`);
    throw err;
  }
}

async function ensureExchangeAvailable() {
  await safeGet('/fapi/v1/ping');
}

// -------------------------------------------------------------
// TELEGRAM BOT AUTO-SCANNER SYSTEM & TP/SL TRACKER
// -------------------------------------------------------------
const ACTIVE_TRADES_FILE = path.join(__dirname, 'active_trades.json');
const TRADE_HISTORY_FILE = path.join(__dirname, 'trade_history.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

function loadSettings() {
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    } catch (e) {
      console.error('[settings] Gagal membaca settings.json:', e.message);
    }
  }
  return { 
    daily_pnl_target: 10,
    daily_loss_limit: 50, // Default $50
    fixed_tp_usdt: 0.5, // Default $0.5
    risk_per_trade_pct: 1.5, // PRO: Risk 1.5% dari balance per trade
    max_consecutive_losses: 3 // PRO: Pause setelah 3 loss berturut
  };
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  } catch (e) {
    console.error('[settings] Gagal menyimpan settings.json:', e.message);
  }
}

function getDailyPnL() {
  const history = loadHistory();
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  
  return history
    .filter(t => t.timestamp >= startOfDay)
    .reduce((sum, t) => sum + (t.pnlUsdt || 0), 0);
}

/**
 * Menghitung Statistik PnL (Profit & Loss) untuk periode tertentu
 * @param {number} days - Jumlah hari ke belakang
 */
function getPnLStats(days = 1) {
  const history = loadHistory();
  const now = Date.now();
  const startTime = now - (days * 24 * 60 * 60 * 1000);
  
  const filtered = history.filter(t => t.timestamp >= startTime);
  
  const profit = filtered
    .filter(t => (t.pnlUsdt || 0) > 0)
    .reduce((sum, t) => sum + t.pnlUsdt, 0);
    
  const loss = filtered
    .filter(t => (t.pnlUsdt || 0) < 0)
    .reduce((sum, t) => sum + Math.abs(t.pnlUsdt), 0);
    
  return {
    period: days === 1 ? 'Daily' : (days === 7 ? 'Weekly' : 'Monthly'),
    profit: parseFloat(profit.toFixed(2)),
    loss: parseFloat(loss.toFixed(2)),
    net: parseFloat((profit - loss).toFixed(2)),
    count: filtered.length
  };
}

/**
 * Menghitung Total PnL Harian (Realized + Unrealized/Floating)
 */
async function getNetDailyPnL() {
  const realized = getDailyPnL();
  let unrealizedTotal = 0;
  
  try {
    const activePositions = await getBinancePositions();
    unrealizedTotal = activePositions.reduce((sum, pos) => {
      return sum + (parseFloat(pos.unRealizedProfit) || 0);
    }, 0);
  } catch (err) {
    console.error('[pnl] Gagal mengambil floating profit untuk kalkulasi Net PnL:', err.message);
  }
  
  return realized + unrealizedTotal;
}

function loadActiveTrades() {
  // Gunakan cache jika sudah tersedia
  if (cachedActiveTrades) return cachedActiveTrades;

  if (fs.existsSync(ACTIVE_TRADES_FILE)) {
    try {
      cachedActiveTrades = JSON.parse(fs.readFileSync(ACTIVE_TRADES_FILE, 'utf8'));
      return cachedActiveTrades;
    } catch (e) {
      console.error('[tracker] Gagal membaca active_trades.json:', e.message);
    }
  }
  cachedActiveTrades = {};
  return cachedActiveTrades;
}

function saveActiveTrades(trades) {
  cachedActiveTrades = trades; // Update cache
  try {
    fs.writeFileSync(ACTIVE_TRADES_FILE, JSON.stringify(trades, null, 2), 'utf8');
  } catch (e) {
    console.error('[tracker] Gagal menyimpan active_trades.json:', e.message);
  }
}

function loadHistory() {
  if (fs.existsSync(TRADE_HISTORY_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(TRADE_HISTORY_FILE, 'utf8'));
    } catch (e) {
      console.error('[history] Gagal membaca trade_history.json:', e.message);
    }
  }
  return [];
}

function saveToHistory(trade, exitPrice = null, reason = 'UNKNOWN') {
  const history = loadHistory();
  const margin = trade.margin || parseFloat(process.env.TRADE_QUANTITY_USDT) || 20;
  const leverage = trade.leverage || parseInt(process.env.DEFAULT_LEVERAGE) || 10;
  
  const finalExit = exitPrice || trade.exit || trade.entry;
  
  const isLong = trade.type === 'LONG';
  const pnlPercent = isLong 
    ? ((finalExit - trade.entry) / trade.entry) * 100 
    : ((trade.entry - finalExit) / trade.entry) * 100;
  const pnlUsdt = (pnlPercent / 100) * (margin * leverage);

  // PRO: Update consecutive loss tracker
  if (pnlUsdt < 0) {
    consecutiveLosses++;
    console.log(`[risk] Consecutive losses: ${consecutiveLosses}`);
  } else if (pnlUsdt > 0) {
    if (consecutiveLosses > 0) {
      console.log(`[risk] Win! Streak reset dari ${consecutiveLosses} losses.`);
    }
    consecutiveLosses = 0; // Reset on win
  }

  const entry = {
    ...trade,
    exit: finalExit,
    reason: reason,
    pnlPercent: parseFloat(pnlPercent.toFixed(2)),
    pnlUsdt: parseFloat(pnlUsdt.toFixed(2)),
    closedAt: Date.now()
  };

  recentlyClosed.set(trade.symbol, Date.now());
  setTimeout(() => recentlyClosed.delete(trade.symbol), 300000);

  history.unshift(entry);
  const trimmed = history.slice(0, 200);
  
  try {
    fs.writeFileSync(TRADE_HISTORY_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
    console.log(`[history] Trade ${trade.symbol} tersimpan. Exit: $${finalExit} | PnL: ${entry.pnlUsdt} USDT (${reason})`);
  } catch (e) {
    console.error('[history] Gagal menyimpan trade_history.json:', e.message);
  }
}

async function sendTelegramMessage(text) {
  const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
  if (!TELEGRAM_TOKEN || !CHAT_ID) return false;

  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  try {
    await axios.post(url, {
      chat_id: CHAT_ID,
      text: text,
      parse_mode: 'Markdown'
    });
    return true;
  } catch (err) {
    console.error(`[telegram] Gagal mengirim pesan ke Telegram:`, err.message);
    return false;
  }
}

async function sendToTelegram(signalData) {
  const signalText = signalData.signal.signal;
  const emoji = signalText.includes('LONG') ? '🟢' : (signalText.includes('SHORT') ? '🔴' : '⚪');
  const entry = signalData.market ? signalData.market.price : signalData.price;

  const text = `📡 *[SCANNER] SIGNAL ALERT: ${signalData.symbol}* ${emoji}
  
Tipe: *${signalText}* (Skor: ${signalData.signal.score})
Confidence: ${signalData.signal.confidence}%
 Harga Entry: ${entry}

🎯 *TARGET:*
TP 1: ${signalData.signal.levels.tp1}
TP 2: ${signalData.signal.levels.tp2}
TP 3: ${signalData.signal.levels.tp3}

🛑 *STOP LOSS:* ${signalData.signal.levels.sl}
⚖️ RR Ratio: ${signalData.signal.levels.rr}
📊 Volume Conviction: ${signalData.rvol >= 1.2 ? 'HIGH ✅' : 'LOW ⚠️'} (RVOL: ${signalData.rvol.toFixed(2)})

🌍 *HTF TREND (4h):* ${signalData.signal.htfTrend}${signalData.signal.htfConflict ? ' ⚠️ (CONFLICT)' : ' ✅'}

_⚠️ Catatan: Sinyal ini hanya alert manual. Auto-trade memerlukan Confidence >= 80%._`;

  const sent = await sendTelegramMessage(text);
  if (sent) console.log(`[telegram] Sinyal ${signalData.symbol} berhasil dikirim ke Telegram.`);
}

let isScanning = false;

async function runBackgroundScanner() {
  if (isScanning) {
    console.warn(`[cron-scan] Pemindaian sedang berlangsung, skip pemanggilan baru.`);
    return;
  }

  isScanning = true;
  try {
    const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (!TELEGRAM_TOKEN) return;
  
  const minScore = parseInt(process.env.TELEGRAM_MIN_SCORE, 10) || 9;
  const autoTradeMinConf = parseInt(process.env.AUTO_TRADE_MIN_CONFIDENCE, 10) || 80;
  const interval = process.env.TRADING_TIMEFRAME || '1h';
  const maxOpen = parseInt(process.env.MAX_OPEN_POSITIONS, 10) || 5;
  const batchSize = 5; // Perkecil dari 10 ke 5 agar tidak memicu 429

  console.log(`\n[cron-scan] Memulai pemindaian (${interval}) untuk ${WATCHLIST.length} koin...`);
  
  // 🛡️ CANDLE-CLOSE CONFIRMATION: hanya entry jika candle hampir selesai
  // Mencegah entry prematur di mid-candle yang sering reversal
  const now = Date.now();
  const intervalMsMap = { '1m': 60000, '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000 };
  const tf = intervalMsMap[interval] || 900000;
  const candleProgress = ((now % tf) / tf) * 100;
  const MIN_CANDLE_PROGRESS = 75; // Hanya entry jika candle sudah 75%+ complete
  
  if (candleProgress < MIN_CANDLE_PROGRESS) {
    console.log(`[cron-scan] Skip scan: candle baru ${candleProgress.toFixed(0)}% selesai (min: ${MIN_CANDLE_PROGRESS}%). Menunggu konfirmasi close.`);
    return;
  }
  console.log(`[cron-scan] Candle progress: ${candleProgress.toFixed(0)}% ✅ (threshold: ${MIN_CANDLE_PROGRESS}%)`);
  
  // 🔥 MASTER FILTER: Ambil sentimen pasar BTC (5m)
  const btcStatus = await getBTCStatus();
  console.log(`[market-watch] Sentimen BTC: ${btcStatus.isBullish ? 'BULLISH ✅' : 'BEARISH ⚠️'} | Price: $${btcStatus.price.toFixed(1)}`);
  
  if (btcStatus.isPanic) {
     console.error(`[market-watch] BTC PANIC DETECTED (Flash Crash). Scan dibatalkan demi keamanan.`);
     await sendTelegramMessage(`⚠️ *BTC MARKET PANIC* ⚠️\nTerdeteksi penurunan tajam pada BTC. Bot mematalkan pemindaian koin ALT untuk mencegah loss.`);
     return;
  }

  try {
    await ensureExchangeAvailable();
  } catch (error) {
    console.error(`[cron-scan] Koneksi ke bursa gagal, scan dibatalkan.`);
    return;
  }

  // Cek posisi terbuka asli di bursa
  let rawPositions = [];
  if (process.env.TRADING_ENABLED === 'true') {
     rawPositions = await getBinancePositions();
     if (rawPositions === null) {
       console.error(`[cron-scan] Gagal terhubung ke Binance Positions API. Scan ditangguhkan untuk mencegah double-entry.`);
       return; // Abort scan jika API posisi gagal, untuk mencegah double entry!
     }
     currentOpenPositions = rawPositions.length;
     console.log(`[trade] Posisi terbuka saat ini: ${currentOpenPositions}/${maxOpen}`);
  }

  const dailyNetPnL = await getNetDailyPnL(); // Pre-fetch daily PnL once

  const activeTrades = loadActiveTrades();
  const uniqueWatchlist = [...new Set(WATCHLIST)];
  
  // List Koin Utama untuk Syarat Standar (Lainnya harus syarat ketat)
  const CORE_SYMBOLS = new Set(['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'MATICUSDT', 'DOTUSDT', 'TRXUSDT', 'LTCUSDT', 'DOGEUSDT', 'LINKUSDT']);

  for (let i = 0; i < uniqueWatchlist.length; i += batchSize) {
    const batch = uniqueWatchlist.slice(i, i + batchSize);
    const settled = await Promise.allSettled(
      batch.map((symbol) => analyzePair(symbol, interval, false, btcStatus))
    );

    for (const result of settled) {
      if (result.status === 'fulfilled') {
        const item = result.value;
        if (Math.abs(item.signal.score) >= minScore) {
          const isCore = CORE_SYMBOLS.has(item.symbol);
          const currentType = item.signal.signal.includes('LONG') ? 'LONG' : 'SHORT';
          const existing = activeTrades[item.symbol];
          
          // ANTI-SPAM: Hanya kirim ke Telegram jika koin belum ada di active trades dengan tipe yang sama
          // ANTI-DUPLICATE: Jangan buka jika sudah ada posisi riil di Binance untuk koin ini
          const hasRealPosition = rawPositions.some(p => p.symbol === item.symbol);
          
          if ((!existing || existing.type !== currentType) && !hasRealPosition) {
            // 🔥 SPEED OPTIMIZATION: Check confidence and execute trade BEFORE Telegram (saves 1-2s)
            
            // SCALPING MODE: Threshold lebih rendah untuk entry lebih sering
            const isScalpMode = interval === '5m' || interval === '1m' || interval === '15m';
            const requiredConf = isScalpMode 
              ? (isCore ? 70 : 75)   // Scalp: lebih agresif
              : (isCore ? autoTradeMinConf : Math.max(85, autoTradeMinConf + 5));
            const requiredScore = isScalpMode
              ? (isCore ? 5 : 7)     // Scalp: score lebih rendah OK
              : (isCore ? minScore : Math.max(10, minScore + 1));
            
            const meetsConfidence = item.signal.confidence >= requiredConf;
            const meetsScore = Math.abs(item.signal.score) >= requiredScore;
            // Scalping: Tidak wajib HTF aligned (karena scalp melawan HTF itu normal)
            const trendAligned = isScalpMode ? true : 
                                 ((item.signal.htfTrend === 'BULLISH' && currentType === 'LONG') || 
                                  (item.signal.htfTrend === 'BEARISH' && currentType === 'SHORT'));

            if (process.env.TRADING_ENABLED === 'true' && currentOpenPositions < maxOpen) {
              if (meetsConfidence && meetsScore && trendAligned) {
                // Scalping: Skip slow MTF confirmation, langsung execute
                let canExecute = true;
                
                if (!isScalpMode) {
                  // Swing mode: tetap pakai MTF confirmation
                  const mtfConfirm = await confirmMultiTimeframe(item.symbol, currentType);
                  const corrCheck = checkCorrelationConflict(item.symbol, activeTrades);
                  const isVeryStrong = isCore ? Math.abs(item.signal.score) >= 9 : Math.abs(item.signal.score) >= 11;
                  canExecute = (mtfConfirm.consensus === 'STRONG' || (isVeryStrong && mtfConfirm.consensus === 'WEAK')) && 
                               !corrCheck.conflict && 
                               (!item.signal.reasons?.some(r => r.includes('⚠️')));
                } else {
                  // Scalping mode: cek korelasi saja, skip MTF (terlalu lambat)
                  const corrCheck = checkCorrelationConflict(item.symbol, activeTrades);
                  canExecute = !corrCheck.conflict;
                }

                if (canExecute) {
                  // EXECUTE TRADE IMMEDIATELY (FAST PATH)
                  const success = await executeBinanceTrade(item, dailyNetPnL);
                  if (success) {
                    currentOpenPositions++;
                    console.log(`[tracker] Start tracking: ${item.symbol}`);
                  }
                } else {
                  // NOTIFY SKIP REASON ON TELEGRAM (Only for High Score)
                  let skipReason = "";
                  if (corrCheck.conflict) skipReason = `Correlation conflict with ${corrCheck.conflictPair}`;
                  else if (mtfConfirm.consensus === 'WEAK' && !isVeryStrong) skipReason = `Multi-TF weak consensus (${mtfConfirm.agreements}/${mtfConfirm.total})`;
                  else if (item.signal.reasons?.some(r => r.includes('⚠️'))) skipReason = `Low volume breakout warning`;
                  
                  if (skipReason) {
                    console.log(`[trade] Skip auto-trade ${item.symbol}: ${skipReason}`);
                    // Only send notification if score >= minScore (avoid spam)
                    await sendTelegramMessage(`⚠️ *AUTO-TRADE SKIPPED: ${item.symbol}* ⚠️\n\nSignal Score: ${item.signal.score}\nReason: ${skipReason}\n\n_Auto-trade dibatalkan untuk menjaga keamanan akun._`);
                  }
                }
              } else if (meetsConfidence && meetsScore && !trendAligned) {
                console.log(`[trade] Skip auto-trade ${item.symbol}: HTF Trend Conflict (${item.signal.htfTrend} vs ${currentType})`);
                await sendTelegramMessage(`⚠️ *AUTO-TRADE SKIPPED: ${item.symbol}* ⚠️\n\nReason: HTF Trend Conflict (${item.signal.htfTrend} vs ${currentType})\n\n_Bot hanya entry jika searah dengan tren besar (4H)._`);
              } else if (Math.abs(item.signal.score) >= minScore) {
                 // Log why it didn't meet the stricter altcoin requirements
                 if (!isCore) {
                    console.log(`[trade] Skip auto-trade ${item.symbol}: Altcoin requirement not met (Score: ${item.signal.score}/${requiredScore}, Conf: ${item.signal.confidence}%/${requiredConf}%)`);
                 }
              }
            }

            // Send to telegram without awaiting to avoid blocking the scan
            sendToTelegram(item).catch(e => console.error('[telegram] Failed to send:', e.message));
            console.log(`[telegram] Sinyal Terdeteksi: ${item.symbol} (${currentType})`);
          } else {
            console.log(`[tracker] Update: ${item.symbol} tetap ${currentType}, notif diabaikan (anti-spam).`);
          }
        }
      }
    }
    
    if (i + batchSize < uniqueWatchlist.length) {
      await sleep(200);
    }
  }
  
  saveActiveTrades(activeTrades);
  console.log(`[cron-scan] Pemindaian selesai.`);
  } catch (err) {
    console.error(`[cron-scan] Gagal pemindaian:`, err.message);
  } finally {
    isScanning = false;
  }
}

// -------------------------------------------------------------
// WEBSOCKET MANAGER (LIVE STREAM)
// -------------------------------------------------------------
function initBinanceWebSocket() {
  const wsUrl = USE_TESTNET 
    ? 'wss://fstream.binancefuture.com/ws/!ticker@arr'
    : 'wss://fstream.binance.com/ws/!ticker@arr';
  console.log(`[ws] Menghubungkan ke ${wsUrl} (${USE_TESTNET ? 'TESTNET' : 'MAINNET'})...`);

  wsConnection = new WebSocket(wsUrl);

  wsConnection.on('open', () => {
    console.log('[ws] Terhubung ke Binance Live Stream (All Tickers)');
    wsStatus = 'CONNECTED';
  });

  wsConnection.on('message', async (data) => {
    try {
      const tickers = JSON.parse(data);
      if (!Array.isArray(tickers)) return;

      const activeTrades = loadActiveTrades();
      let modified = false;

      for (const t of tickers) {
        const symbol = t.s;
        const currentPrice = parseFloat(t.c);
        livePrices[symbol] = currentPrice;

        // Cek trade yang sedang berjalan (menggunakan cache memori agar instan/irit)
        if (activeTrades[symbol]) {
          const trade = activeTrades[symbol];
          const result = await checkTradeLevels(symbol, currentPrice, activeTrades);
          if (result.modified) {
            modified = true;
          }
        }
      }

      if (modified) {
        saveActiveTrades(activeTrades);
      }
    } catch (err) {
      console.error('[ws] Error pemrosesan data:', err.message);
    }
  });

  wsConnection.on('error', (err) => {
    console.error('[ws] Error koneksi:', err.message);
    wsStatus = 'ERROR';
  });

  wsConnection.on('close', () => {
    console.log('[ws] Koneksi terputus. Menyambung kembali dalam 5 detik...');
    wsStatus = 'DISCONNECTED';
    setTimeout(initBinanceWebSocket, 5000);
  });
}

/**
 * Menutup sebagian posisi (Partial Close) via Binance Market Order.
 * Dipanggil oleh: checkTradeLevels() saat TP1 hit.
 * Dependensi: tradingApi (Binance signed), signRequest.
 * Side effects: Market order (reduce-only) di Binance.
 */
async function closePartialPosition(symbol, quantity, tradeType) {
  if (!quantity || parseFloat(quantity) <= 0) {
    console.error(`[trade] Partial close ${symbol}: quantity invalid (${quantity})`);
    return false;
  }
  try {
    const side = tradeType === 'LONG' ? 'SELL' : 'BUY';
    const orderParams = signRequest({
      symbol,
      side,
      type: 'MARKET',
      quantity,
      reduceOnly: 'true'
    });
    const res = await tradingApi.post('/fapi/v1/order', orderParams);
    console.log(`[trade] Partial close OK: ${symbol} ${quantity} (${side}) | OrderID: ${res.data.orderId}`);
    return true;
  } catch (err) {
    console.error(`[trade] Partial close GAGAL ${symbol}:`, err.response?.data?.msg || err.message);
    return false;
  }
}

/**
 * Logika pengecekan TP/SL untuk satu koin (Sekali Terdeteksi Langsung Beraksi)
 * Dipanggil oleh: WebSocket on('message'), monitorActiveTrades() (fallback polling).
 * Dependensi: moveStopLossToBreakEven, closePartialPosition, sendTelegramMessage.
 * Side effects: Modify activeTrades in-memory, panggil Binance API untuk SL+/partial close.
 */
async function checkTradeLevels(sym, currentPrice, livePrices) {
  const activeTrades = loadActiveTrades();
  const trade = activeTrades[sym];
  if (!trade) return { modified: false };

  let changed = false;
  const isLong = trade.type === 'LONG';
  
  // Anti-Spam: Pastikan notifikasi yang sama tidak dikirim berulang kali (Cooldown 30 detik)
  function shouldNotify(type) {
    const key = `${sym}_${type}`;
    const now = Date.now();
    if (lastNotified[key] && now - lastNotified[key] < 30000) return false;
    lastNotified[key] = now;
    return true;
  }

  if (trade.pendingClosure) return { modified: false };

  const pnl = isLong 
    ? ((currentPrice - trade.entry) / trade.entry) * 100 
    : ((trade.entry - currentPrice) / trade.entry) * 100;
  const pnlStr = pnl.toFixed(2) + '%';

  // 1. Cek SL
  const hitSl = isLong ? (currentPrice <= trade.sl) : (currentPrice >= trade.sl);
  if (hitSl) {
    if (shouldNotify('SL')) {
      await sendTelegramMessage(`🚧 *STOP LOSS PRICE TARGET HIT: ${sym}* 🚧\n\nTarget harga Stop Loss ($${trade.sl}) tersentuh oleh harga pasar ($${currentPrice}).\nBot sedang memantau eksekusi penutupan otomatis.`);
      
      trade.pendingClosure = true;
      saveActiveTrades(activeTrades);
      return { modified: true };
    }
  }

  // 2. Cek TP3
  const hitTp3 = isLong ? (currentPrice >= trade.tp3) : (currentPrice <= trade.tp3);
  if (hitTp3) {
    if (shouldNotify('TP3')) {
      await sendTelegramMessage(`💰 *TAKE PROFIT 3 PRICE TARGET HIT: ${sym}* 💰\n\nTarget harga Profit 3 ($${trade.tp3}) tersentuh oleh harga pasar ($${currentPrice}).\nHarga ini menandakan trade telah mencapai target maksimal.`);
      
      trade.pendingClosure = true;
      saveActiveTrades(activeTrades);
      return { modified: true };
    }
  }

  // 3. Cek TP2 (Memicu SL+ Level 2: Geser ke TP1)
  if (!trade.hitTp2) {
    const hitTp2 = isLong ? (currentPrice >= trade.tp2) : (currentPrice <= trade.tp2);
    if (hitTp2) {
      if (shouldNotify('TP2')) {
        trade.hitTp2 = true;
        trade.hitTp1 = true;
        changed = true;
        
        await sendTelegramMessage(`✅ *TARGET TP2 HIT: ${sym}* ✅\n\nPrice: ${currentPrice}\nPnL: ${pnlStr}`);
        
        // SL+ Level 2: SELALU aktif saat TP2 hit — geser SL ke level TP1
        if (process.env.TRADING_ENABLED === 'true') {
           const tp1Price = trade.tp1;
           // SL sedikit di bawah TP1 agar tidak langsung ke-trigger (buffer 0.05%)
           const finalBePrice = parseFloat((trade.type === 'LONG' ? tp1Price * 0.9995 : tp1Price * 1.0005).toFixed(trade.precision?.price || 4));
           
           const beSuccess = await moveStopLossToBreakEven(sym, null, trade.type, finalBePrice);
           if (beSuccess) {
              trade.sl = finalBePrice;
              trade.slMovedToTp1 = true;
              changed = true;
              await sendTelegramMessage(`🛡️ *SL+ UPGRADE: ${sym}* 🛡️\n\nTarget TP2 tercapai, Stop Loss sisa posisi digeser ke level TP1 (${finalBePrice})!`);
           }
        }
      }
    }
  }

  // 4. TP1 (Memicu Partial TP 30% & SL Break-Even)
  if (!trade.hitTp1) {
    const hitTp1 = isLong ? (currentPrice >= trade.tp1) : (currentPrice <= trade.tp1);
    if (hitTp1) {
      if (shouldNotify('TP1')) {
        trade.hitTp1 = true;
        changed = true;
        
        if (!trade.isPartiallyClosed && process.env.TRADING_ENABLED === 'true') {
           // FIX: 30% close (bukan 50%) agar lebih banyak posisi ride ke TP2/TP3
           const qtyToClose = trade.initialQty ? (trade.initialQty * 0.3).toFixed(trade.precision?.quantity || 3) : null;
           
           console.log(`[trade] Menjalankan Partial TP 30% untuk ${sym}...`);
           const success = await closePartialPosition(sym, qtyToClose, trade.type);
           
           if (success) {
              trade.isPartiallyClosed = true;
              const bePrice = trade.type === 'LONG' ? trade.entry * 1.001 : trade.entry * 0.999;
              const finalBePrice = parseFloat(bePrice.toFixed(trade.precision?.price || 2));
              
              const beSuccess = await moveStopLossToBreakEven(sym, null, trade.type, finalBePrice);
              if (beSuccess) trade.sl = finalBePrice;
              
              changed = true;
              await sendTelegramMessage(`💰 *TP1 HIT & PROFIT SECURED: ${sym}* 💰\n\n- 30% posisi ditutup di profit.\n- Stop Loss sisa posisi digeser ke Break-Even (${finalBePrice}).\n\nTrade ini sekarang *Bebas Risiko (Risk-Free)!* 🚀`);
           } else {
              await sendTelegramMessage(`⚠️ *TP1 HIT - Gagal Partial Close: ${sym}* ⚠️\n\nDeteksi harga TP1 tercapai namun eksekusi penutupan 30% gagal di Binance. Mohon cek manual.`);
           }
        } else {
           await sendTelegramMessage(`✅ *TARGET TP1 HIT: ${sym}* ✅\n\nPrice: ${currentPrice}\nPnL: ${pnlStr}`);
        }
      }
    }
  }

  // --- 🔥 PERCENTAGE-BASED TRAILING SL ---
  // Lebih adaptif dari fixed dollar: setiap koin punya volatilitas beda
  // BE trigger: profit >= 0.15% (setelah leverage = 3% move) → kunci ke entry
  // Trailing: profit >= 0.35% → trailing offset 0.15% di bawah profit running
  if (process.env.TRADING_ENABLED === 'true') {
      const margin = trade.margin || parseFloat(process.env.TRADE_QUANTITY_USDT) || 10;
      const leverage = trade.leverage || parseInt(process.env.DEFAULT_LEVERAGE) || 10;
      const posValue = margin * leverage;
      
      // Hitung PnL dalam persentase harga (bukan dollar)
      const pnlPct = isLong 
        ? ((currentPrice - trade.entry) / trade.entry) * 100 
        : ((trade.entry - currentPrice) / trade.entry) * 100;
      
      // Persentase-based params (adaptif ke semua koin)
      const bePct = 0.15;         // BE lock saat profit >= 0.15% price move
      const trailStartPct = 0.35; // Mulai trailing saat profit >= 0.35%
      const trailOffsetPct = 0.15; // Trailing offset 0.15% di bawah high
      
      let newSlPriceRaw = null;

      // KONDISI A: Profit >= 0.15% tapi < 0.35% → kunci ke Break-Even
      if (pnlPct >= bePct && pnlPct < trailStartPct) {
          const bePrice = isLong ? trade.entry * 1.0003 : trade.entry * 0.9997; // Tiny buffer untuk fee
          newSlPriceRaw = bePrice;
      } 
      // KONDISI B: Profit >= 0.35% → Trailing
      else if (pnlPct >= trailStartPct) {
          const lockPct = pnlPct - trailOffsetPct;
          newSlPriceRaw = isLong 
            ? trade.entry * (1 + lockPct / 100)
            : trade.entry * (1 - lockPct / 100);
      }

      if (newSlPriceRaw !== null) {
          const newSlPrice = parseFloat(newSlPriceRaw.toFixed(trade.precision?.price || 4));
          
          // PROTEKSI: Hanya pindahkan SL jika harga baru LEBIH BAIK dari SL saat ini
          const currentSl = trade.sl || (isLong ? 0 : 999999);
          const isBetter = isLong ? (newSlPrice > currentSl) : (newSlPrice < currentSl);

          // Toleransi minimal 0.03% agar tidak terlalu sering hit API
          const slMovePct = Math.abs((newSlPrice - currentSl) / trade.entry) * 100;
          
          if (isBetter && slMovePct > 0.03) {
              const lockedPct = Math.max(0, pnlPct - trailOffsetPct).toFixed(2);
              console.log(`[trailing-sl] ${sym} PnL=${pnlPct.toFixed(3)}% | SL → $${newSlPrice} (Lock: ~${lockedPct}%)`);
              
              const beSuccess = await moveStopLossToBreakEven(sym, null, trade.type, newSlPrice);
              if (beSuccess) {
                  trade.sl = newSlPrice;
                  changed = true;
                  // Notif Telegram hanya saat pertama kali BE aktif atau profit signifikan
                  if (!trade._beNotified || pnlPct >= 0.5) {
                    trade._beNotified = true;
                    const pnlUsdt = (pnlPct / 100) * posValue;
                    await sendTelegramMessage(`🛡️ *TRAILING SL: ${sym}* 🛡️\n\nProfit: ${pnlPct.toFixed(2)}% ($${pnlUsdt.toFixed(2)})\nSL Baru: $${newSlPrice}\nProfit Terkunci: ~${lockedPct}%`);
                  }
              }
          }
      }
  }


  if (changed) saveActiveTrades(activeTrades);
  return { modified: changed };
}

/**
 * Adopsi posisi yang tidak dikenal (dibuka manual) agar bisa diawasi bot
 */
async function adoptOrphanPositions() {
  if (process.env.TRADING_ENABLED !== 'true') return;
  
  try {
     const rawPositions = await getBinancePositions();
     const maxOpen = parseInt(process.env.MAX_OPEN_POSITIONS) || 5;
     const activeTrades = loadActiveTrades();
     
     currentOpenPositions = rawPositions.length;
    let changed = false;
    
    for (const pos of rawPositions) {
      const sym = pos.symbol;
      
      // SKIP jika koin baru saja ditutup (Cegah duplikasi history)
      if (recentlyClosed.has(sym)) {
        continue;
      }

      if (!activeTrades[sym] && WATCHLIST.includes(sym)) {
        // Ditemukan posisi manual yang koinnya ada di watchlist
        const side = parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT';
        const entryPrice = parseFloat(pos.entryPrice);
        const leverage = parseInt(pos.leverage);
        const margin = parseFloat(pos.isolatedWallet || 0);

        // Buat dummy TP/SL (akan segera dioverwrite oleh Trailing SL jika profit)
        activeTrades[sym] = {
           symbol: sym,
           type: side,
           entry: entryPrice,
           leverage: leverage,
           margin: margin,
           initialQty: Math.abs(parseFloat(pos.positionAmt)),
           tp1: side === 'LONG' ? entryPrice * 1.01 : entryPrice * 0.99,
           tp2: side === 'LONG' ? entryPrice * 1.02 : entryPrice * 0.98,
           tp3: side === 'LONG' ? entryPrice * 1.03 : entryPrice * 0.97,
           sl: side === 'LONG' ? entryPrice * 0.98 : entryPrice * 1.02,
           isPartiallyClosed: false,
           hitTp1: false,
           hitTp2: false,
           last_pnl_step: 0,
           timestamp: Date.now(),
           adopted: true
        };
        changed = true;
        console.log(`[adoption] Mengadopsi posisi manual: ${sym} (${side})`);
        sendTelegramMessage(`🤝 *POSISI DIADOPSI: ${sym}* 🤝\n\nPosisi manual Anda dideteksi dan sekarang mulai diawasi oleh bot dengan aturan Trailing SL terbaru.`);
      }
    }
    
    if (changed) saveActiveTrades(activeTrades);
  } catch (e) {
    console.error('[adoption] Gagal mengadopsi posisi:', e.message);
  }
}

async function monitorActiveTrades() {
  // Masih dipertahankan untuk redundansi atau update UI via REST
  const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (!TELEGRAM_TOKEN) return;

  const activeTrades = loadActiveTrades();
  const symbols = Object.keys(activeTrades);
  
  // Cek posisi baru di bursa setiap menit
  adoptOrphanPositions();

  if (symbols.length === 0) return;

  // Sync dengan posisi riel di Binance untuk mendeteksi penutupan manual
  try {
    const rawPositions = await getBinancePositions();
    if (rawPositions === null) return; // Prevent deleting activeTrades if API fails

    const openOrders = await getBinanceOpenOrders(); // Fix: Tambahkan fetch open orders
    const liveSymbols = rawPositions.map(p => p.symbol);
    let historyChanged = false;

    for (const sym of symbols) {
      const trade = activeTrades[sym];
      const livePos = rawPositions.find(p => p.symbol === sym);
      
      const currentPrice = livePrices[sym] || trade.entry;
      
      // Update check trade levels with AWAIT for stability
      await checkTradeLevels(sym, currentPrice, livePrices);
      
      if (!liveSymbols.includes(sym)) {
        // Koin ini ada di catatan bot, tapi sudah tidak ada di bursa (Berarti sudah ditutup manual/TP/SL)
        const currentPrice = livePrices[sym] || trade.entry;
        const isLong = trade.type === 'LONG';
        
        console.log(`[monitor] ${sym} sudah tertutup di bursa. Memindahkan ke history.`);
        
        // Tentukan alasan penutupan berdasarkan harga saat ini (estimasi)
        let reason = 'MARKET / MANUAL';
        if (trade.sl && (isLong ? currentPrice <= trade.sl : currentPrice >= trade.sl)) reason = 'STOP LOSS';
        if (trade.tp3 && (isLong ? currentPrice >= trade.tp3 : currentPrice <= trade.tp3)) reason = 'TAKE PROFIT';

        await saveToHistory(trade, currentPrice, reason);
        delete activeTrades[sym];
        historyChanged = true;
        sendTelegramMessage(`ℹ️ *TRADE CLOSED: ${sym}* ℹ️\n\nPosisi telah ditutup (${reason}). Data telah dipindahkan ke History.`);
      } else if (livePos && process.env.TRADING_ENABLED === 'true') {
        // SELF-HEALING: Jika posisi terbuka tapi TP/SL tidak ada di bursa, pasang ulang
        // Check both standard orders AND algo orders
        const coinOrders = openOrders.filter(o => o.symbol === sym);
        const algoOrders = await getOpenAlgoOrders(sym);
        
        const hasTp = coinOrders.some(o => o.type === 'TAKE_PROFIT_MARKET') || 
                      algoOrders.some(o => o.type === 'TAKE_PROFIT_MARKET');
        const hasSl = coinOrders.some(o => o.type === 'STOP_MARKET') || 
                      algoOrders.some(o => o.type === 'STOP_MARKET');

        if (!hasTp && trade.tp2) {
          console.log(`[self-healing] Menemukan TP hilang untuk ${sym}. Memasang ulang via Algo API...`);
          const info = await getExchangeInfo();
          const prec = getSymbolPrecision(sym, info);
          await placeAlgoOrder({
            symbol: sym,
            side: trade.type === 'LONG' ? 'SELL' : 'BUY',
            type: 'TAKE_PROFIT_MARKET',
            triggerPrice: parseFloat(trade.tp2).toFixed(prec.price),
            closePosition: 'true',
            workingType: 'MARK_PRICE'
          }).catch(e => console.error(`[self-healing] Gagal pasang TP ${sym}:`, e.response?.data?.msg || e.message));
        }

        if (!hasSl && trade.sl) {
          console.log(`[self-healing] Menemukan SL hilang untuk ${sym}. Memasang ulang via Algo API...`);
          const info = await getExchangeInfo();
          const prec = getSymbolPrecision(sym, info);
          await placeAlgoOrder({
            symbol: sym,
            side: trade.type === 'LONG' ? 'SELL' : 'BUY',
            type: 'STOP_MARKET',
            triggerPrice: parseFloat(trade.sl).toFixed(prec.price),
            closePosition: 'true',
            workingType: 'MARK_PRICE'
          }).catch(e => console.error(`[self-healing] Gagal pasang SL ${sym}:`, e.response?.data?.msg || e.message));
        }
      }

    }
    
    if (historyChanged) saveActiveTrades(activeTrades);
  } catch (e) {
    console.error('[history-sync] Gagal sinkronisasi histori penutupan:', e.message);
  }

  // Jika WebSocket Down, gunakan polling sebagai fallback
  if (wsStatus !== 'CONNECTED') {
    try {
      const response = await api.get('/fapi/v1/ticker/price');
      const prices = response.data;
      let modified = false;
      const priceMap = {};
      for (const p of prices) { priceMap[p.symbol] = parseFloat(p.price); }

      for (const sym of symbols) {
        const trade = activeTrades[sym];
        const currentPrice = priceMap[sym];
        if (!currentPrice) continue;
        const res = await checkTradeLevels(sym, currentPrice, activeTrades);
        if (res.modified) modified = true;
      }
      if (modified) saveActiveTrades(activeTrades);
    } catch (e) {
      console.error('[tracker] Fallback monitor error:', e.message);
    }
  }
}

// Inisialisasi Cron Job Scanner - Default setiap 15 menit agar data selalu segar
const schedule = process.env.CRON_SCHEDULE || '*/15 * * * *'; 
if (process.env.TELEGRAM_BOT_TOKEN) {
  cron.schedule(schedule, () => {
    runBackgroundScanner();
  });
  
  // Fitur Tracker Koin memantau harga real-time setiap 1 menit!
  cron.schedule('* * * * *', () => {
    monitorActiveTrades();
  });
  
  console.log(`[cron-scan] Bot Telegram aktif. Auto-scan menggunakan jadwal: ${schedule}`);
  console.log(`[tracker] Fitur Tracker Koin (TP/SL) aktif memantau harga setiap 1 menit.`);
}
// -------------------------------------------------------------

app.get('/api/health', (_, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    pairs: WATCHLIST.length,
    version: '3.2.0-FIX',
    marketBaseURL: getMarketBaseUrl(),
    tradingBaseURL: getActiveBaseUrl(),
    wsStatus,
    tradingTimeframe: process.env.TRADING_TIMEFRAME || '1h',
    tradingEnabled: process.env.TRADING_ENABLED === 'true'
  });
});

app.get('/api/live-prices', (req, res) => {
  // Mengirim harga terbaru dari WebSocket memory cache
  res.json({
    timestamp: Date.now(),
    prices: livePrices,
    wsStatus: wsStatus
  });
});

app.get('/api/settings', async (req, res) => {
    res.json({
        ...loadSettings(),
        current_daily_pnl: await getNetDailyPnL(),
        realized_daily_pnl: getDailyPnL()
    });
});

app.post('/api/settings', (req, res) => {
    const { daily_pnl_target, daily_loss_limit, fixed_tp_usdt } = req.body;
    
    const settings = loadSettings();
    if (daily_pnl_target !== undefined) {
        const val = String(daily_pnl_target).replace(',', '.');
        settings.daily_pnl_target = parseFloat(val);
    }
    if (daily_loss_limit !== undefined) {
        const val = String(daily_loss_limit).replace(',', '.');
        settings.daily_loss_limit = parseFloat(val);
    }
    if (fixed_tp_usdt !== undefined) {
        const val = String(fixed_tp_usdt).replace(',', '.');
        settings.fixed_tp_usdt = parseFloat(val);
    }
    
    saveSettings(settings);
    res.json({ success: true, settings });
});

app.get('/api/debug-connection', async (req, res) => {
  const symbol = 'BTCUSDT';
  const target = getActiveBaseUrl();
  const results = {
    target,
    testnet: process.env.USE_BINANCE_TESTNET === 'true',
    steps: []
  };

  try {
    results.steps.push({ name: 'DNS/Ping Test', status: 'trying' });
    await api.get('/fapi/v1/ping');
    results.steps[0].status = 'OK';
    
    results.steps.push({ name: 'Klines Test', status: 'trying' });
    const kRes = await api.get('/fapi/v1/klines', { params: { symbol, interval: '1h', limit: 1 } });
    results.steps[1].status = 'OK';
    results.data_sample = kRes.data[0];
    
    res.json({ success: true, results });
  } catch (err) {
    const norm = normalizeAxiosError(err);
    res.status(500).json({
      success: false,
      results,
      error_code: err.code,
      error_status: err.response?.status,
      full_message: norm.message,
      axios_config: {
        url: err.config?.url,
        method: err.config?.method,
        baseURL: err.config?.baseURL,
        headers: err.config?.headers
      }
    });
  }
});

app.get('/api/histori', (req, res) => {
  const history = loadHistory();
  
  // Hitung stats kumulatif
  const totalTrades = history.length;
  const wins = history.filter(t => t.pnlUsdt > 0).length;
  const totalPnL = history.reduce((sum, t) => sum + t.pnlUsdt, 0);
  
  res.json({
    history: history.slice(0, 50),
    stats: {
      totalTrades,
      winRate: totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : 0,
      totalPnL: totalPnL.toFixed(2),
      currency: 'USDT'
    },
    periods: {
      daily: getPnLStats(1),
      weekly: getPnLStats(7),
      monthly: getPnLStats(30)
    }
  });
});

app.get('/api/watchlist', (_, res) => {
  res.json({ pairs: WATCHLIST });
});

app.get('/api/cron-run', async (req, res) => {
  console.log('[cron-trigger] Manual trigger received from API.');
  try {
    // Run scanner in background without waiting for it to finish (to avoid timeout)
    runBackgroundScanner()
      .then(() => console.log('[cron-trigger] Background scan completed.'))
      .catch((err) => console.error('[cron-trigger] Background scan error:', err.message));
    
    res.json({
      status: 'triggered',
      message: 'Background scanner started',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to trigger scanner', details: error.message });
  }
});

app.get('/api/active-trades', async (req, res) => {
  try {
    const activeTrades = loadActiveTrades();
    const [positions, openOrders, algoOrders] = await Promise.all([
      getBinancePositions(),
      getBinanceOpenOrders(),
      getOpenAlgoOrders()
    ]);
    
    if (positions.length === 0) return res.json([]);
    
    const results = positions.map(pos => {
      const sym = pos.symbol;
      const amount = parseFloat(pos.positionAmt);
      const entry = parseFloat(pos.entryPrice);
      const mark = parseFloat(pos.markPrice);
      const isLong = amount > 0;
      const pnl = parseFloat(pos.unRealizedProfit);
      const pnlPercent = isLong 
        ? ((mark - entry) / entry) * 100 
        : ((entry - mark) / entry) * 100;
        
      // Cari TP/SL dari standard orders DAN algo orders
      const coinOrders = openOrders.filter(o => o.symbol === sym);
      const coinAlgoOrders = algoOrders.filter(o => o.symbol === sym);
      
      const tpOrder = coinOrders.find(o => o.type === 'TAKE_PROFIT_MARKET') || 
                      coinAlgoOrders.find(o => o.type === 'TAKE_PROFIT_MARKET');
      const slOrder = coinOrders.find(o => o.type === 'STOP_MARKET') || 
                      coinAlgoOrders.find(o => o.type === 'STOP_MARKET');

      // Algo orders use triggerPrice, standard orders use stopPrice
      const tpPrice = tpOrder ? parseFloat(tpOrder.stopPrice || tpOrder.triggerPrice) : null;
      const slPrice = slOrder ? parseFloat(slOrder.stopPrice || slOrder.triggerPrice) : null;

      return {
        symbol: sym,
        type: isLong ? 'LONG' : 'SHORT',
        entry,
        currentPrice: mark,
        pnl: parseFloat(pnl.toFixed(2)),
        pnlPercent: parseFloat(pnlPercent.toFixed(2)),
        margin: parseFloat(pos.isolatedWallet || 0),
        leverage: pos.leverage,
        tp: tpPrice,
        sl: slPrice,
        last_pnl_step: activeTrades[sym]?.last_pnl_step || 0,
        timestamp: Date.now()
      };
    });

    
    res.json(results);
  } catch (err) {
    console.error('[api] Gagal sinkronisasi data bursa:', err.message);
    res.status(500).json({ error: 'Gagal sinkronisasi data posisi riil' });
  }
});

app.get('/api/test-api', async (req, res) => {
  try {
    const account = await fetchSigned('GET', '/fapi/v2/account');
    const balance = account.assets.find(a => a.asset === 'USDT');
    res.json({
      status: 'connected',
      environment: USE_TESTNET ? 'Testnet' : 'Live',
      wsStatus,
      balance: balance ? parseFloat(balance.walletBalance).toFixed(2) : '0',
      positionsCount: account.positions.filter(p => parseFloat(p.positionAmt) !== 0).length,
      config: {
        minScore: parseInt(process.env.TELEGRAM_MIN_SCORE, 10) || 9,
        minConf: parseInt(process.env.AUTO_TRADE_MIN_CONFIDENCE, 10) || 80,
        maxOpen: parseInt(process.env.MAX_OPEN_POSITIONS, 10) || 5,
        tradingEnabled: process.env.TRADING_ENABLED === 'true'
      }
    });
  } catch (err) {
    const msg = err.response?.data?.msg || err.message;
    res.status(401).json({ status: 'error', message: msg });
  }
});

app.get('/api/scanner', async (req, res) => {
  const startedAt = Date.now();
  const interval = req.query.interval || '1h';
  const minScore = parseInt(req.query.minScore, 10) || 0; 
  const results = [];
  const failures = [];
  const failureDetails = [];

  console.log(`\n[scan] BATCH MODE (${WATCHLIST.length} pairs) | interval=${interval}`);
  const batchSize = 10; // Meningkatkan kecepatan dengan memproses 10 koin sekaligus

  for (let i = 0; i < WATCHLIST.length; i += batchSize) {
    const batch = WATCHLIST.slice(i, i + batchSize);
    const settled = await Promise.allSettled(
      batch.map((symbol) => analyzePair(symbol, interval, false))
    );

    for (let j = 0; j < settled.length; j++) {
      const res = settled[j];
      const symbol = batch[j];
      
      if (res.status === 'fulfilled') {
        const item = res.value;
        // Filter out skipped pairs (low liquidity, etc.)
        if (item.skip) {
          console.log(`  skip ${symbol}: ${item.reason}`);
          continue;
        }
        if (item.signal && Math.abs(item.signal.score) >= minScore) {
          results.push(item);
        }
        if (item.signal) {
          console.log(`  ok ${symbol} -> ${item.signal.signal} (${item.signal.score})`);
        }
      } else {
        const err = res.reason;
        const normalized = normalizeAxiosError(err);
        failures.push(symbol);
        const errMsg = normalized?.message || JSON.stringify(err)?.substring(0, 100) || 'Unknown batch error';
        failureDetails.push({ symbol, error: errMsg });
        console.error(`  fail ${symbol}: ${errMsg}`);
      }
    }
    
    // Jeda antar batch diperkecil menjadi 500ms (Sangat Cepat tapi Tetap Aman)
    if (i + batchSize < WATCHLIST.length) {
      await sleep(500);
    }
  }

  const filtered = results
    .filter((item) => Math.abs(item.signal.score) >= minScore)
    .sort((a, b) => Math.abs(b.signal.score) - Math.abs(a.signal.score));

  console.log(
    `[scan] Done: ${results.length} succeeded, ${failures.length} failed in ${Date.now() - startedAt}ms\n`
  );

  res.json({
    count: filtered.length,
    success: results.length,
    failed: failures.length,
    failures,
    failureDetails,
    elapsed: Date.now() - startedAt,
    interval,
    baseURL: getActiveBaseUrl(),
    data: filtered,
  });
});

app.get('/api/analyze/:symbol', async (req, res) => {
  try {
    const data = await analyzePair(req.params.symbol.toUpperCase(), req.query.interval || '1h', true);
    res.json({ ...data, timestamp: Date.now(), baseURL: getActiveBaseUrl() });
  } catch (error) {
    handleRouteError(res, error, 'Analyze request failed');
  }
});

app.get('/api/funding', async (_, res) => {
  try {
    const { data } = await api.get('/fapi/v1/premiumIndex');
    res.json(
      data
        .filter((item) => WATCHLIST.includes(item.symbol))
        .map((item) => ({
          symbol: item.symbol,
          markPrice: parseFloat(item.markPrice),
          fundingRate: parseFloat(item.lastFundingRate) * 100,
          nextFundingTime: item.nextFundingTime,
        }))
        .sort((a, b) => Math.abs(b.fundingRate) - Math.abs(a.fundingRate))
    );
  } catch (error) {
    handleRouteError(res, error, 'Funding request failed');
  }
});

app.get('/api/klines/:symbol', async (req, res) => {
  try {
    const { data } = await api.get('/fapi/v1/klines', {
      params: {
        symbol: req.params.symbol.toUpperCase(),
        interval: req.query.interval || '1h',
        limit: 200,
      },
    });

    res.json(
      data.map((kline) => ({
        time: kline[0],
        open: Number(kline[1]),
        high: Number(kline[2]),
        low: Number(kline[3]),
        close: Number(kline[4]),
        volume: Number(kline[5]),
      }))
    );
  } catch (error) {
    handleRouteError(res, error, 'Klines request failed');
  }
});

app.use((err, _req, res, _next) => {
  handleRouteError(res, err, 'Unhandled server error');
});

app.listen(PORT, HOST, async () => {
    console.log('\n==========================================');
    console.log('  Futures Signal Scanner (GO LIVE MODE)');
    console.log(`  http://${HOST}:${PORT}`);
    console.log(`  Binance base URL: ${getActiveBaseUrl()}`);
    console.log('==========================================\n');
    
    await updateWatchlist();
    if (process.env.USE_WEBSOCKET !== 'false') {
      initBinanceWebSocket();
    }

    setInterval(updateWatchlist, 3600 * 1000); // 1 hour
});
