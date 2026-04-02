/**
 * Binance Futures Signal Scanner - Backend Server
 * Adds configurable exchange endpoints and clearer network diagnostics.
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
const HOST = process.env.IP || '::';
const DEFAULT_BINANCE_BASE_URL = 'https://fapi.binance.com';
const REQUEST_TIMEOUT_MS = Number(process.env.BINANCE_TIMEOUT_MS) || 15000;

function parseBaseUrls() {
  const raw =
    process.env.BINANCE_BASE_URLS ||
    process.env.BINANCE_BASE_URL ||
    DEFAULT_BINANCE_BASE_URL;

  return Array.from(
    new Set(
      raw
        .split(',')
        .map((value) => value.trim().replace(/\/+$/, ''))
        .filter(Boolean)
    )
  );
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

// URL untuk Trading API (Order, Position) — bisa testnet jika diaktifkan
function getActiveBaseUrl() {
  const USE_TESTNET = process.env.USE_BINANCE_TESTNET === 'true';
  const defaultTestnet = 'https://fapi-testnet.binance.com';

  if (USE_TESTNET) return defaultTestnet;
  return getMarketBaseUrl();
}

// Global Live State (Memory Cache)
let livePrices = {};
let wsConnection = null;
let wsStatus = 'DISCONNECTED';
let cachedActiveTrades = null; // Cache untuk cegah I/O berlebih
let lastNotified = {}; // Tracker anti-spam notifikasi (symbol_type -> timestamp)

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

let WATCHLIST = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'
];

async function updateWatchlist() {
  try {
    const { data } = await safeGet('/fapi/v1/ticker/24hr');
    const eligible = data
      .filter((item) => {
        const symbol = item.symbol;
        if (!symbol.endsWith('USDT') || symbol.includes('_')) return false;
        // Gunakan threshold volume dari .env (default list minimal 30jt USDT)
        const minVol = parseFloat(process.env.SCANNER_MIN_VOLUME_USDT) || 30000000;
        return parseFloat(item.quoteVolume) >= minVol;
      })
      .map((item) => item.symbol);

    if (eligible.length > 0) {
      WATCHLIST = eligible;
      console.log(`[system] Watchlist diperbarui otomatis: ${WATCHLIST.length} koin siap discan.`);
      console.log(`[system] Koin: ${WATCHLIST.slice(0, 10).join(', ')}${WATCHLIST.length > 10 ? '...' : ''}`);
    }
  } catch (error) {
    console.error('[system] Gagal memperbarui watchlist otomatis:', error.message);
  }
}


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
      return await api.get(url, { params });
    } catch (error) {
      const status = error.response?.status;
      // Jika Rate Limit (429) atau Service Unavailable (503), putar URL dan COOLDOWN lebih lama
      if ((status === 429 || status === 503 || !error.response) && i < retries) {
        const wait = status === 429 ? 3000 + (i * 2000) : 500;
        console.warn(`[api] Error ${status || 'network'}. Rotating URL & cooldown ${wait}ms...`);
        rotateBaseUrl();
        await sleep(wait); 
        continue;
      }
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
  timeout: 10000,
  headers: {
    'X-MBX-APIKEY': BINANCE_API_KEY,
    'Content-Type': 'application/x-www-form-urlencoded'
  }
});

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

async function getExchangeInfo() {
  if (exchangeInfoCache) return exchangeInfoCache;
  try {
    const res = await api.get('/fapi/v1/exchangeInfo');
    exchangeInfoCache = res.data;
    return exchangeInfoCache;
  } catch (err) {
    console.error('[binance] Gagal ambil Exchange Info:', err.message);
    return null;
  }
}

function getSymbolPrecision(symbol, info) {
  if (!info) return { price: 2, quantity: 3 };
  const sym = info.symbols.find(s => s.symbol === symbol);
  if (!sym) return { price: 2, quantity: 3 };
  
  const priceFilter = sym.filters.find(f => f.filterType === 'PRICE_FILTER');
  const lotFilter = sym.filters.find(f => f.filterType === 'LOT_SIZE');
  
  const tickSize = priceFilter ? parseFloat(priceFilter.tickSize) : 0.01;
  const stepSize = lotFilter ? parseFloat(lotFilter.stepSize) : 0.001;
  
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
  const res = await tradingApi(config);
  return res.data;
}

async function getBinancePositions() {
  try {
    // Filter hanya posisi yang memiliki jumlah koin (aktif)
    const positions = await fetchSigned('GET', '/fapi/v2/positionRisk');
    return positions.filter(p => parseFloat(p.positionAmt) !== 0);
  } catch (err) {
    console.error('[binance] Gagal ambil posisi:', err.response?.data?.msg || err.message);
    return [];
  }
}

async function getBinanceOpenOrders(symbol = null) {
  try {
    const params = symbol ? { symbol } : {};
    return await fetchSigned('GET', '/fapi/v1/openOrders', params);
  } catch (err) {
    console.error(`[binance] Gagal ambil open orders ${symbol || ''}:`, err.response?.data?.msg || err.message);
    return [];
  }
}

async function moveStopLossToBreakEven(symbol, entryPrice, side) {
  if (process.env.TRADING_ENABLED !== 'true') return false;
  
  try {
    const info = await getExchangeInfo();
    const precision = getSymbolPrecision(symbol, info);
    
    // 1. Ambil Open Orders untuk mencari SL (STOP_MARKET)
    const openOrders = await getBinanceOpenOrders(symbol);
    const slOrders = openOrders.filter(o => o.type === 'STOP_MARKET');
    
    // 2. Batalkan semua SL lama
    for (const order of slOrders) {
      await fetchSigned('DELETE', '/fapi/v1/order', {
        symbol,
        orderId: order.orderId
      });
      console.log(`[trade] SL Lama Dibatalkan: ${symbol} (${order.orderId})`);
    }
    
    // 3. Pasang SL Baru di harga Entry + 0.1% (untuk cover fee & profit tipis)
    // Long: Entry * 1.001, Short: Entry * 0.999
    const isLong = side === 'BUY' || side === 'LONG';
    const bePrice = isLong ? entryPrice * 1.001 : entryPrice * 0.999;
    const finalBePrice = parseFloat(bePrice.toFixed(precision.price));
    
    const slParams = signRequest({
      algoType: 'CONDITIONAL',
      symbol,
      side: isLong ? 'SELL' : 'BUY',
      type: 'STOP_MARKET',
      triggerPrice: finalBePrice,
      closePosition: 'true',
      workingType: 'MARK_PRICE'
    });
    
    await tradingApi.post('/fapi/v1/algoOrder', slParams);
    
    console.log(`[trade] SL Moved to Break-Even: ${symbol} @ ${finalBePrice}`);
    await sendTelegramMessage(`🛡️ *SL PLUS ACTIVATED: ${symbol}* 🛡️\n\nStop Loss telah digeser ke harga Entry (${finalBePrice}) untuk mengunci keuntungan. Trade ini sekarang aman dari kerugian (Risk-Free)!`);
    return true;
  } catch (err) {
    console.error(`[trade] Gagal menggeser SL ke Break-Even ${symbol}:`, err.response?.data?.msg || err.message);
    return false;
  }
}

async function executeBinanceTrade(signalData) {
  if (process.env.TRADING_ENABLED !== 'true' || !BINANCE_API_KEY || !BINANCE_SECRET_KEY) {
    return;
  }

  // Cek Target PnL Harian
  const settings = loadSettings();
  const currentPnL = getDailyPnL();
  if (currentPnL >= settings.daily_pnl_target) {
    console.log(`[trade] Skip auto-trade ${signalData.symbol}: Target harian (${settings.daily_pnl_target} USDT) sudah tercapai. PnL Hari Ini: ${currentPnL.toFixed(2)} USDT`);
    return;
  }

  const { symbol, signal, price } = signalData;

  // Simbol TradFi-Perps (Commodity / Logam) memerlukan persetujuan khusus di Binance.
  // Scanner boleh tampilkan sinyalnya, tapi auto-trade di-skip dengan notif yang jelas.
  const TRADFI_SYMBOLS = new Set([
    'XAUUSDT', 'XAGUSDT', 'XPTUSDТ', 'WBETHUSDT',
    // Tambahkan simbol lain jika perlu
  ]);
  if (TRADFI_SYMBOLS.has(symbol)) {
    console.log(`[trade] Skip auto-trade ${symbol}: Simbol TradFi-Perps, perlu sign agreement di Binance terlebih dahulu.`);
    return;
  }

  const side = signal.signal.includes('LONG') ? 'BUY' : 'SELL';
  const oppositeSide = side === 'BUY' ? 'SELL' : 'BUY';
  
  const usdtAmount = parseFloat(process.env.TRADE_QUANTITY_USDT) || 20;
  const leverage = parseInt(process.env.DEFAULT_LEVERAGE) || 10;

  console.log(`[trade] Mengeksekusi order ${symbol} (${side}) senilai ${usdtAmount} USDT...`);

  try {
    const info = await getExchangeInfo();
    const precision = getSymbolPrecision(symbol, info);
    
    // 1. Set Leverage
    const levParams = signRequest({ symbol, leverage });
    await tradingApi.post('/fapi/v1/leverage', levParams);

    // 2. Hitung Quantity
    const quantity = (usdtAmount * leverage) / price;
    const formattedQty = quantity.toFixed(precision.quantity);
    
    // 3. Main Order (Market)
    const orderParams = signRequest({
      symbol,
      side,
      type: 'MARKET',
      quantity: formattedQty
    });
    
    const mainOrder = await tradingApi.post('/fapi/v1/order', orderParams);
    console.log(`[trade] Entry Berhasil! Order ID: ${mainOrder.data.orderId}`);

    // 4. TP & SL (MENGGUNAKAN NEW ALGO ORDER ENDPOINT)
    // Sejak Des 2024, TP/SL Market wajib lewat /fapi/v1/algoOrder
    if (signal.levels) {
      const tpPrice = parseFloat(signal.levels.tp2).toFixed(precision.price);
      const slPrice = parseFloat(signal.levels.sl).toFixed(precision.price);

      // TP Order (Take Profit Market via Algo)
      const tpParams = signRequest({
        algoType: 'CONDITIONAL',
        symbol,
        side: oppositeSide,
        type: 'TAKE_PROFIT_MARKET',
        triggerPrice: tpPrice,
        closePosition: 'true',
        workingType: 'MARK_PRICE'
      });
      await tradingApi.post('/fapi/v1/algoOrder', tpParams);

      // SL Order (Stop Market via Algo)
      const slParams = signRequest({
        algoType: 'CONDITIONAL',
        symbol,
        side: oppositeSide,
        type: 'STOP_MARKET',
        triggerPrice: slPrice,
        closePosition: 'true',
        workingType: 'MARK_PRICE'
      });
      await tradingApi.post('/fapi/v1/algoOrder', slParams);
      
      console.log(`[trade] TP/SL Terpasang (via Algo): TP2 @ ${tpPrice}, SL @ ${slPrice}`);
      await sendTelegramMessage(`🚀 *AUTO-TRADE EXECUTED* 🚀\n\nKoin: ${symbol}\nTipe: ${side}\nLeverage: ${leverage}x\nEntry: ${price}\nTP2: ${tpPrice}\nSL: ${slPrice}\n\n_Eksekusi di Binance Testnet beres!_`);
    }

  } catch (err) {
    const msg = err.response?.data?.msg || err.message;
    const errCode = err.response?.data?.code;

    // Deteksi error Agreement TradFi-Perps dari Binance
    if (msg && msg.toLowerCase().includes('tradfi') || msg.toLowerCase().includes('agreement') || errCode === -4185) {
      console.warn(`[trade] Skip ${symbol}: Perlu sign TradFi-Perps Agreement di Binance.com terlebih dahulu.`);
      await sendTelegramMessage(`ℹ️ *INFO AUTO-TRADE: ${symbol}*\n\nSimbol ini adalah produk TradFi-Perps (Commodity/Logam).\n\nUntuk mengaktifkan auto-trade, silakan sign agreement di:\nBinance Futures → ${symbol} → Accept Agreement\n\nScanner tetap aktif, sinyal tetap dikirim.`);
      return;
    }

    console.error(`[trade] Gagal mengeksekusi order ${symbol}:`, msg);
    await sendTelegramMessage(`⚠️ *AUTO-TRADE FAILED* ⚠️\n\nKoin: ${symbol}\nError: ${msg}`);
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

  let gains = 0;
  let losses = 0;

  for (let i = closes.length - period; i < closes.length; i += 1) {
    const delta = closes[i] - closes[i - 1];
    if (delta > 0) gains += delta;
    else losses += Math.abs(delta);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;

  return parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2));
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
  if (closes.length < 35) return { macd: 0, signal: 0, histogram: 0 };

  const macdSeries = [];
  for (let i = 26; i <= closes.length; i += 1) {
    const slice = closes.slice(0, i);
    macdSeries.push(calcEMA(slice, 12) - calcEMA(slice, 26));
  }

  const macdLine = macdSeries[macdSeries.length - 1];
  const signalLine = macdSeries.length >= 9 ? calcEMA(macdSeries, 9) : macdLine * 0.85;

  return {
    macd: parseFloat(macdLine.toFixed(8)),
    signal: parseFloat(signalLine.toFixed(8)),
    histogram: parseFloat((macdLine - signalLine).toFixed(8)),
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

function generateSignal(indicators, price, fundingRate, interval = '1h') {
  let score = 0;
  const reasons = [];
  const { rsi, macd, ema20, ema50, ema9, ema21, bb, stochRSI, vwap, atr } = indicators;
  const isScalp = interval === '1m' || interval === '5m';

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
    if (isScalp && macd.histogram > 0) score += 1;
    reasons.push('MACD bullish crossover');
  } else if (macd.macd < macd.signal) {
    score -= 2;
    if (isScalp && macd.histogram < 0) score -= 1;
    reasons.push('MACD bearish crossover');
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
  if (adx > 25) {
    score += 1;
    reasons.push(`Strong trend (ADX: ${adx})`);
    if (plusDI > minusDI) score += 1;
    else score -= 1;
  } else if (adx < 20) {
    // Sideways market - avoid trend followers, reduce scores
    score = score * 0.7; 
    reasons.push(`Weak trend (ADX: ${adx}), being cautious`);
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

  if (price > vwap) {
    score += 1;
    reasons.push('Price above VWAP');
  } else {
    score -= 1;
    reasons.push('Price below VWAP');
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

  const isLong = score >= 0;
  const entry = price;
  
  // FIXED PROFIT SCALPING LOGIC
  const fixedProfit = parseFloat(process.env.FIXED_PROFIT_USDT) || 0;
  const margin = parseFloat(process.env.TRADE_QUANTITY_USDT) || 20;
  const leverage = parseInt(process.env.DEFAULT_LEVERAGE) || 10;
  const posValue = margin * leverage;

  let tp1, tp2, tp3, sl;
  
  // TP Ratio Optimization
  // Scalping: TP1 (ATR 1.0), TP2 (ATR 2.0), TP3 (ATR 3.5), SL (ATR 1.5)
  // Swing: TP1 (ATR 1.5), TP2 (ATR 3.0), TP3 (ATR 5.0), SL (ATR 2.0)
  const factor1 = isScalp ? 1.0 : 1.5;
  const factor2 = isScalp ? 2.0 : 3.0;
  const factor3 = isScalp ? 3.5 : 5.0;
  const slFactor = isScalp ? 1.5 : 2.0;

  if (fixedProfit > 0 && posValue > 0) {
    const priceDiff = (fixedProfit / posValue) * entry;
    tp1 = isLong ? entry + priceDiff : entry - priceDiff;
  } else {
    tp1 = isLong ? entry + atr * factor1 : entry - atr * factor1;
  }

  tp2 = isLong ? entry + atr * factor2 : entry - atr * factor2;
  tp3 = isLong ? entry + atr * factor3 : entry - atr * factor3;
  sl = isLong ? entry - atr * slFactor : entry + atr * slFactor;
  
  const rr = Math.abs(sl - entry) > 0
    ? parseFloat((Math.abs(tp2 - entry) / Math.abs(sl - entry)).toFixed(2))
    : 0;

  const formatPrice = (value) => parseFloat(value.toFixed(price > 100 ? 2 : 6));

  return {
    signal,
    strength,
    score,
    confidence: parseFloat(confidence.toFixed(1)),
    reasons: reasons.slice(0, 6),
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

async function analyzePair(symbol, interval = '1h', full = false) {
  try {
    const [klinesRes, tickerRes, fundingRes] = await Promise.all([
      safeGet('/fapi/v1/klines', { symbol, interval, limit: full ? 200 : 100 }),
      safeGet('/fapi/v1/ticker/24hr', { symbol }),
      safeGet('/fapi/v1/premiumIndex', { symbol }),
    ]);

    const klines = klinesRes.data;
    const ticker = tickerRes.data;
    const funding = fundingRes.data;

    if (!Array.isArray(klines) || klines.length === 0) {
      throw new Error(`No kline data returned for ${symbol}`);
    }

    const closes = klines.map((kline) => parseFloat(kline[4]));
    const price = parseFloat(ticker.lastPrice);
    const fundingRate = parseFloat(funding.lastFundingRate) * 100;

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
    };

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
      indicators,
      signal: generateSignal(indicators, price, fundingRate, interval),
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
    console.error(`[analyze] Error for ${symbol}:`, err.message);
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
  return { daily_pnl_target: 10 }; // Default $10
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

function saveToHistory(trade) {
  const history = loadHistory();
  const margin = parseFloat(process.env.TRADE_QUANTITY_USDT) || 20;
  const leverage = parseInt(process.env.DEFAULT_LEVERAGE) || 10;
  
  // Hitung profit nominal (USDT)
  const isLong = trade.type === 'LONG';
  const pnlPercent = isLong 
    ? ((trade.exit - trade.entry) / trade.entry) * 100 
    : ((trade.entry - trade.exit) / trade.entry) * 100;
  const pnlUsdt = (pnlPercent / 100) * (margin * leverage);

  const entry = {
    ...trade,
    pnlPercent: parseFloat(pnlPercent.toFixed(2)),
    pnlUsdt: parseFloat(pnlUsdt.toFixed(2)),
    timestamp: Date.now()
  };

  history.unshift(entry); // Masukkan ke paling depan
  // Simpan maksimal 200 trade terakhir agar tidak bengkak filenya
  const trimmed = history.slice(0, 200);
  
  try {
    fs.writeFileSync(TRADE_HISTORY_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
    console.log(`[history] Trade ${trade.symbol} tersimpan. PnL: ${entry.pnlUsdt} USDT`);
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

  const text = `🚨 *SIGNAL ALERT: ${signalData.symbol}* ${emoji}
  
Tipe: *${signalText}* (Skor: ${signalData.signal.score})
Confidence: ${signalData.signal.confidence}%
Harga Entry: ${entry}

🎯 *TARGET:*
TP 1: ${signalData.signal.levels.tp1}
TP 2: ${signalData.signal.levels.tp2}
TP 3: ${signalData.signal.levels.tp3}

🛑 *STOP LOSS:* ${signalData.signal.levels.sl}
⚖️ RR Ratio: ${signalData.signal.levels.rr}`;

  const sent = await sendTelegramMessage(text);
  if (sent) console.log(`[telegram] Sinyal ${signalData.symbol} berhasil dikirim ke Telegram.`);
}

async function runBackgroundScanner() {
  const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (!TELEGRAM_TOKEN) return;
  
  const minScore = parseInt(process.env.TELEGRAM_MIN_SCORE, 10) || 7;
  const autoTradeMinConf = parseInt(process.env.AUTO_TRADE_MIN_CONFIDENCE, 10) || 80;
  const interval = process.env.TRADING_TIMEFRAME || '1h';
  const maxOpen = parseInt(process.env.MAX_OPEN_POSITIONS, 10) || 5;
  const batchSize = 5; // Perkecil dari 10 ke 5 agar tidak memicu 429

  console.log(`\n[cron-scan] Memulai pemindaian (${interval}) untuk ${WATCHLIST.length} koin...`);
  
  try {
    await ensureExchangeAvailable();
  } catch (error) {
    console.error(`[cron-scan] Koneksi ke bursa gagal, scan dibatalkan.`);
    return;
  }

  // Cek posisi terbuka asli di bursa
  let currentOpenPositions = 0;
  if (process.env.TRADING_ENABLED === 'true') {
     const positions = await getBinancePositions();
     currentOpenPositions = positions.length;
     console.log(`[trade] Posisi terbuka saat ini: ${currentOpenPositions}/${maxOpen}`);
  }

  const activeTrades = loadActiveTrades();

  for (let i = 0; i < WATCHLIST.length; i += batchSize) {
    const batch = WATCHLIST.slice(i, i + batchSize);
    const settled = await Promise.allSettled(
      batch.map((symbol) => analyzePair(symbol, interval, false))
    );

    for (const result of settled) {
      if (result.status === 'fulfilled') {
        const item = result.value;
        if (Math.abs(item.signal.score) >= minScore) {
          const entry = item.market ? item.market.price : item.price;
          const currentType = item.signal.signal.includes('LONG') ? 'LONG' : 'SHORT';
          const existing = activeTrades[item.symbol];
          
          // ANTI-SPAM: Hanya kirim ke Telegram jika koin belum ada di active trades dengan tipe yang sama
          if (!existing || existing.type !== currentType) {
            await sendToTelegram(item);
            console.log(`[telegram] Sinyal Baru: ${item.symbol} (${currentType})`);
            
            // 🔥 EKSEKUSI AUTO-TRADE (Filter: Enabled, Slot Kosong, & Konfidensi Tinggi)
            const meetsConfidence = item.signal.confidence >= autoTradeMinConf;
            
            if (process.env.TRADING_ENABLED === 'true' && currentOpenPositions < maxOpen) {
              if (meetsConfidence) {
                executeBinanceTrade(item);
                currentOpenPositions++;
              } else {
                console.log(`[trade] Skip auto-trade ${item.symbol}: Konfidensi (${item.signal.confidence}%) < target (${autoTradeMinConf}%)`);
              }
            } else if (currentOpenPositions >= maxOpen) {
              console.log(`[trade] Skip ${item.symbol}: Limit posisi maksimal (${maxOpen}) penuh.`);
            }
          } else {
            console.log(`[tracker] Update: ${item.symbol} tetap ${currentType}, notif diabaikan (anti-spam).`);
          }
          
          // Tetap update data TP/SL terbaru di database lokal agar tracker tetap akurat
          activeTrades[item.symbol] = {
            symbol: item.symbol,
            type: currentType,
            entry: parseFloat(entry),
            tp1: parseFloat(item.signal.levels.tp1),
            tp2: parseFloat(item.signal.levels.tp2),
            tp3: parseFloat(item.signal.levels.tp3),
            sl: parseFloat(item.signal.levels.sl),
            hitTp1: existing ? existing.hitTp1 : false,
            hitTp2: existing ? existing.hitTp2 : false,
            timestamp: existing ? existing.timestamp : Date.now()
          };
        }
      }
    }
    
    if (i + batchSize < WATCHLIST.length) {
      await sleep(200);
    }
  }
  
  saveActiveTrades(activeTrades);
  console.log(`[cron-scan] Pemindaian selesai.`);
}

// -------------------------------------------------------------
// WEBSOCKET MANAGER (LIVE STREAM)
// -------------------------------------------------------------
function initBinanceWebSocket() {
  const wsUrl = 'wss://fstream.binance.com/ws/!ticker@arr';
  console.log(`[ws] Menghubungkan ke ${wsUrl}...`);

  wsConnection = new WebSocket(wsUrl);

  wsConnection.on('open', () => {
    console.log('[ws] Terhubung ke Binance Live Stream (All Tickers)');
    wsStatus = 'CONNECTED';
  });

  wsConnection.on('message', (data) => {
    try {
      const tickers = JSON.parse(data);
      if (!Array.isArray(tickers)) return;

      const activeTrades = loadActiveTrades();
      let modified = false;

      tickers.forEach(t => {
        const symbol = t.s;
        const currentPrice = parseFloat(t.c);
        livePrices[symbol] = currentPrice;

        // Cek trade yang sedang berjalan (menggunakan cache memori agar instan/irit)
        if (activeTrades[symbol]) {
          const trade = activeTrades[symbol];
          const result = checkTradeLevels(trade, currentPrice);
          if (result.modified) {
            modified = true;
          }
        }
      });

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
 * Logika pengecekan TP/SL untuk satu koin (Sekali Terdeteksi Langsung Beraksi)
 */
function checkTradeLevels(trade, currentPrice) {
  let changed = false;
  const isLong = trade.type === 'LONG';
  const sym = trade.symbol;
  
  // Anti-Spam: Pastikan notifikasi yang sama tidak dikirim berulang kali (Cooldown 30 detik)
  function shouldNotify(type) {
    const key = `${sym}_${type}`;
    const now = Date.now();
    if (lastNotified[key] && now - lastNotified[key] < 30000) return false;
    lastNotified[key] = now;
    return true;
  }

  const pnl = isLong 
    ? ((currentPrice - trade.entry) / trade.entry) * 100 
    : ((trade.entry - currentPrice) / trade.entry) * 100;
  const pnlStr = pnl.toFixed(2) + '%';

  // 1. Cek SL
  const hitSl = isLong ? (currentPrice <= trade.sl) : (currentPrice >= trade.sl);
  if (hitSl) {
    if (shouldNotify('SL')) {
      sendTelegramMessage(`🛑 *STOP LOSS HIT: ${sym}* 🛑\n\nTipe: ${trade.type}\nEntry: ${trade.entry}\nSL: ${trade.sl}\nHarga Tersentuh: ${currentPrice}\nEst. PnL: ${pnlStr}`);
      const activeTrades = loadActiveTrades();
      
      // Simpan ke History sebelum dihapus
      saveToHistory({
        symbol: sym,
        type: trade.type,
        entry: trade.entry,
        exit: currentPrice,
        reason: 'STOP LOSS'
      });
      
      delete activeTrades[sym];
      // Hapus cache notif juga agar koin ini bisa di-trade lagi nanti
      delete lastNotified[`${sym}_SL`];
      delete lastNotified[`${sym}_TP1`];
      delete lastNotified[`${sym}_TP2`];
      delete lastNotified[`${sym}_TP3`];
      return { modified: true };
    }
  }

  // 2. Cek TP3
  const hitTp3 = isLong ? (currentPrice >= trade.tp3) : (currentPrice <= trade.tp3);
  if (hitTp3) {
    if (shouldNotify('TP3')) {
      sendTelegramMessage(`🚀 *FULL TAKE PROFIT (TP3) HIT: ${sym}* 🚀\n\nTipe: ${trade.type}\nEntry: ${trade.entry}\nTP3: ${trade.tp3}\nEst. PnL: ${pnlStr}\n\n🎉 Trade Selesai! 💰`);
      const activeTrades = loadActiveTrades();
      
      // Simpan ke History sebelum dihapus
      saveToHistory({
        symbol: sym,
        type: trade.type,
        entry: trade.entry,
        exit: currentPrice,
        reason: 'TAKE PROFIT (TP3)'
      });
      
      delete activeTrades[sym];
      return { modified: true };
    }
  }

  // 3. Cek TP2
  if (!trade.hitTp2) {
    const hitTp2 = isLong ? (currentPrice >= trade.tp2) : (currentPrice <= trade.tp2);
    if (hitTp2) {
      if (shouldNotify('TP2')) {
        trade.hitTp2 = true;
        trade.hitTp1 = true;
        changed = true;
        sendTelegramMessage(`✅ *TARGET TP2 HIT: ${sym}* ✅\n\nPrice: ${currentPrice}\nPnL: ${pnlStr}`);
      }
    }
  }

  // 4. Cek TP1 (Memicu SL Plus)
  if (!trade.hitTp1) {
    const hitTp1 = isLong ? (currentPrice >= trade.tp1) : (currentPrice <= trade.tp1);
    if (hitTp1) {
      if (shouldNotify('TP1')) {
        trade.hitTp1 = true;
        changed = true;
        sendTelegramMessage(`✅ *TARGET TP1 HIT: ${sym}* ✅\n\nPrice: ${currentPrice}\nPnL: ${pnlStr}`);
        
        if (!trade.slMoved && process.env.TRADING_ENABLED === 'true') {
          // SL+ Level 1: Geser ke Break-Even (Entry + 0.1%)
          moveStopLossToBreakEven(sym, trade.entry, trade.type).then(success => {
            if (success) {
              const activeTrades = loadActiveTrades();
              if (activeTrades[sym]) {
                activeTrades[sym].slMoved = true;
                activeTrades[sym].sl = trade.type === 'LONG' ? trade.entry * 1.001 : trade.entry * 0.999;
                saveActiveTrades(activeTrades);
              }
            }
          });
        }
      }
    }
  }

  // 5. Cek TP2 (Memicu SL+ Level 2: Geser ke TP1)
  if (trade.hitTp2 && !trade.slMovedToTp1 && process.env.TRADING_ENABLED === 'true') {
      const tp1Price = trade.tp1;
      moveStopLossToBreakEven(sym, tp1Price / (isLong ? 1.001 : 0.999), trade.type).then(success => {
          if (success) {
              const activeTrades = loadActiveTrades();
              if (activeTrades[sym]) {
                  activeTrades[sym].slMovedToTp1 = true;
                  activeTrades[sym].sl = tp1Price;
                  saveActiveTrades(activeTrades);
                  sendTelegramMessage(`🛡️ *SL+ UPGRADE: ${sym}* 🛡️\n\nTarget TP2 tercapai, Stop Loss digeser ke level TP1 (${tp1Price}) untuk mengamankan profit lebih besar!`);
              }
          }
      });
  }

  return { modified: changed };
}

async function monitorActiveTrades() {
  // Masih dipertahankan untuk redundansi atau update UI via REST
  const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (!TELEGRAM_TOKEN) return;

  const activeTrades = loadActiveTrades();
  const symbols = Object.keys(activeTrades);
  if (symbols.length === 0) return;

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
        const res = checkTradeLevels(trade, currentPrice);
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
    version: '2.7-LIVE',
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

app.get('/api/settings', (req, res) => {
    res.json({
        ...loadSettings(),
        current_daily_pnl: getDailyPnL()
    });
});

app.post('/api/settings', (req, res) => {
    const { daily_pnl_target } = req.body;
    if (daily_pnl_target === undefined) return res.status(400).json({ error: 'Data tidak lengkap' });
    
    const settings = { daily_pnl_target: parseFloat(daily_pnl_target) };
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

app.get('/api/trade-history', (req, res) => {
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
    const [positions, openOrders] = await Promise.all([
      getBinancePositions(),
      getBinanceOpenOrders()
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
        
      // Cari TP/SL dari open orders koin ini
      const coinOrders = openOrders.filter(o => o.symbol === sym);
      const tpOrder = coinOrders.find(o => o.type === 'TAKE_PROFIT_MARKET');
      const slOrder = coinOrders.find(o => o.type === 'STOP_MARKET');

      return {
        symbol: sym,
        type: isLong ? 'LONG' : 'SHORT',
        entry,
        currentPrice: mark,
        pnl: parseFloat(pnl.toFixed(2)),
        pnlPercent: parseFloat(pnlPercent.toFixed(2)),
        margin: parseFloat(pos.isolatedWallet || 0),
        leverage: pos.leverage,
        tp: tpOrder ? parseFloat(tpOrder.stopPrice) : null,
        sl: slOrder ? parseFloat(slOrder.stopPrice) : null,
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
        minScore: parseInt(process.env.TELEGRAM_MIN_SCORE, 10) || 7,
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

    for (const res of settled) {
      if (res.status === 'fulfilled') {
        const item = res.value;
        if (Math.abs(item.signal.score) >= minScore) {
          results.push(item);
        }
        console.log(`  ok ${item.symbol} -> ${item.signal.signal} (${item.signal.score})`);
      } else {
        const err = res.reason;
        const normalized = normalizeAxiosError(err);
        failures.push('Unknown');
        failureDetails.push({ error: normalized?.message || 'Unknown batch error' });
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
