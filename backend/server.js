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
        .map((value) => value.trim())
        .filter(Boolean)
    )
  );
}

const BINANCE_BASE_URLS = parseBaseUrls();
let activeBaseIndex = 0;

function getActiveBaseUrl() {
  return BINANCE_BASE_URLS[activeBaseIndex] || DEFAULT_BINANCE_BASE_URL;
}

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

const WATCHLIST = [
  'BTCUSDT',
  'ETHUSDT',
  'BNBUSDT',
  'SOLUSDT',
  'XRPUSDT',
  'DOGEUSDT',
  'ADAUSDT',
  'AVAXUSDT',
  'DOTUSDT',
  'LINKUSDT',
  'MATICUSDT',
  'NEARUSDT',
  'APTUSDT',
  'ARBUSDT',
  'OPUSDT',
  'INJUSDT',
  'SUIUSDT',
  'SEIUSDT',
  'TIAUSDT',
  'WIFUSDT',
  'UNIUSDT',
  'AAVEUSDT',
  'MKRUSDT',
  'CRVUSDT',
  'LDOUSDT',
  'ATOMUSDT',
  'ALGOUSDT',
  'FTMUSDT',
  'HBARUSDT',
  'ICPUSDT',
];

const api = axios.create({
  baseURL: getActiveBaseUrl(),
  timeout: REQUEST_TIMEOUT_MS,
  headers: {
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0',
  },
});

api.interceptors.request.use((config) => {
  config.baseURL = config.baseURL || getActiveBaseUrl();
  return config;
});

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

function generateSignal(indicators, price, fundingRate) {
  let score = 0;
  const reasons = [];
  const { rsi, macd, ema20, ema50, ema200, bb, stochRSI, vwap } = indicators;

  if (rsi < 30) {
    score += 3;
    reasons.push('RSI strongly oversold (< 30)');
  } else if (rsi < 40) {
    score += 2;
    reasons.push('RSI approaching oversold');
  } else if (rsi < 50) {
    score += 1;
  } else if (rsi > 70) {
    score -= 3;
    reasons.push('RSI strongly overbought (> 70)');
  } else if (rsi > 60) {
    score -= 2;
    reasons.push('RSI approaching overbought');
  } else {
    score -= 1;
  }

  if (macd.macd > macd.signal) {
    score += 2;
    reasons.push('MACD bullish crossover');
  } else {
    score -= 2;
    reasons.push('MACD bearish crossover');
  }
  score += macd.histogram > 0 ? 1 : -1;

  if (ema20 > ema50) {
    score += 2;
    reasons.push('EMA20 above EMA50');
  } else {
    score -= 2;
    reasons.push('EMA20 below EMA50');
  }

  if (ema50 > ema200) {
    score += 1;
    reasons.push('EMA50 above EMA200');
  } else {
    score -= 1;
  }

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

  const atr = indicators.atr > 0 ? indicators.atr : price * 0.015;
  const isLong = score >= 0;
  const entry = price;
  const tp1 = isLong ? entry + atr * 1.5 : entry - atr * 1.5;
  const tp2 = isLong ? entry + atr * 3 : entry - atr * 3;
  const tp3 = isLong ? entry + atr * 5 : entry - atr * 5;
  const sl = isLong ? entry - atr : entry + atr;
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
  const [klinesRes, tickerRes, fundingRes] = await Promise.all([
    api.get('/fapi/v1/klines', { params: { symbol, interval, limit: full ? 200 : 100 } }),
    api.get('/fapi/v1/ticker/24hr', { params: { symbol } }),
    api.get('/fapi/v1/premiumIndex', { params: { symbol } }),
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
    ema20: calcEMA(closes, 20),
    ema50: calcEMA(closes, 50),
    ema200: calcEMA(closes, 200),
    bb: calcBB(closes),
    stochRSI: calcStochRSI(closes),
    atr: calcATR(klines),
    vwap: calcVWAP(klines.slice(-24)),
  };

  const signal = generateSignal(indicators, price, fundingRate);
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
    signal,
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
}

async function ensureExchangeAvailable() {
  await api.get('/fapi/v1/ping', {
    timeout: Math.min(REQUEST_TIMEOUT_MS, 5000),
  });
}

// -------------------------------------------------------------
// TELEGRAM BOT AUTO-SCANNER SYSTEM
// -------------------------------------------------------------
async function sendToTelegram(signalData) {
  const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
  
  if (!TELEGRAM_TOKEN || !CHAT_ID) return;

  const signalText = signalData.signal.signal;
  // Emoji indicator
  const emoji = signalText.includes('LONG') ? '🟢' : (signalText.includes('SHORT') ? '🔴' : '⚪');

  const text = `🚨 *SIGNAL ALERT: ${signalData.symbol}* ${emoji}
  
Tipe: *${signalText}* (Skor: ${signalData.signal.score})
Confidence: ${signalData.signal.confidence}%
Harga Entry: ${signalData.market ? signalData.market.price : signalData.price}

🎯 *TARGET:*
TP 1: ${signalData.signal.levels.tp1}
TP 2: ${signalData.signal.levels.tp2}
TP 3: ${signalData.signal.levels.tp3}

🛑 *STOP LOSS:* ${signalData.signal.levels.sl}
⚖️ RR Ratio: ${signalData.signal.levels.rr}`;

  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  try {
    await axios.post(url, {
      chat_id: CHAT_ID,
      text: text,
      parse_mode: 'Markdown'
    });
    console.log(`[telegram] Sinyal ${signalData.symbol} berhasil dikirim ke Telegram.`);
  } catch (err) {
    console.error(`[telegram] Gagal mengirim ${signalData.symbol} ke Telegram:`, err.message);
  }
}

async function runBackgroundScanner() {
  const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (!TELEGRAM_TOKEN) return; // Skip if telegram bot not configured
  
  const minScore = parseInt(process.env.TELEGRAM_MIN_SCORE, 10) || 7;
  const interval = '1h'; // Default signal interval
  const batchSize = 5;

  console.log(`\n[cron-scan] Memulai pemindaian sinyal otomatis untuk Telegram...`);
  
  try {
    await ensureExchangeAvailable();
  } catch (error) {
    console.error(`[cron-scan] Koneksi ke bursa gagal, scan dibatalkan.`);
    return;
  }

  for (let i = 0; i < WATCHLIST.length; i += batchSize) {
    const batch = WATCHLIST.slice(i, i + batchSize);
    const settled = await Promise.allSettled(
      batch.map((symbol) => analyzePair(symbol, interval, false))
    );

    for (const result of settled) {
      if (result.status === 'fulfilled') {
        const item = result.value;
        // Hanya kirim jika mutlak score >= minScore
        if (Math.abs(item.signal.score) >= minScore) {
          await sendToTelegram(item);
        }
      }
    }
    
    if (i + batchSize < WATCHLIST.length) {
      await sleep(200);
    }
  }
  console.log(`[cron-scan] Pemindaian selesai.`);
}

// Inisialisasi Cron Job Scanner
const schedule = process.env.CRON_SCHEDULE || '0 * * * *'; 
if (process.env.TELEGRAM_BOT_TOKEN) {
  cron.schedule(schedule, () => {
    runBackgroundScanner();
  });
  console.log(`[cron-scan] Bot Telegram aktif. Auto-scan menggunakan jadwal: ${schedule}`);
}
// -------------------------------------------------------------

app.get('/api/health', (_, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    pairs: WATCHLIST.length,
    version: '2.1',
    baseURL: getActiveBaseUrl(),
    configuredBaseURLs: BINANCE_BASE_URLS,
  });
});

app.get('/api/watchlist', (_, res) => {
  res.json({ pairs: WATCHLIST });
});

app.get('/api/scanner', async (req, res) => {
  const interval = req.query.interval || '1h';
  const minScore = parseInt(req.query.minScore, 10) || 0;
  const batchSize = 5;
  const startedAt = Date.now();
  const results = [];
  const failures = [];
  const failureDetails = [];

  console.log(`\n[scan] ${WATCHLIST.length} pairs | interval=${interval} | baseURL=${getActiveBaseUrl()}`);

  try {
    await ensureExchangeAvailable();
  } catch (error) {
    const normalized = normalizeAxiosError(error);
    console.error(`[scan] Exchange connectivity check failed: ${normalized.message}`);
    return res.status(getErrorStatusCode(normalized)).json({
      error: normalized.message,
      baseURL: getActiveBaseUrl(),
      configuredBaseURLs: BINANCE_BASE_URLS,
      interval,
    });
  }

  for (let i = 0; i < WATCHLIST.length; i += batchSize) {
    const batch = WATCHLIST.slice(i, i + batchSize);
    const settled = await Promise.allSettled(
      batch.map((symbol) => analyzePair(symbol, interval, false))
    );

    settled.forEach((result, index) => {
      const symbol = batch[index];

      if (result.status === 'fulfilled') {
        results.push(result.value);
        console.log(`  ok ${symbol} -> ${result.value.signal.signal} (${result.value.signal.score})`);
        return;
      }

      const normalized = normalizeAxiosError(result.reason);
      failures.push(symbol);
      failureDetails.push({ symbol, error: normalized?.message || 'Unknown error' });
      console.error(`  fail ${symbol}: ${normalized?.message || 'Unknown error'}`);
    });

    if (i + batchSize < WATCHLIST.length) {
      await sleep(200);
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

app.listen(PORT, HOST, () => {
  console.log('\n==========================================');
  console.log('  Futures Signal Scanner');
  console.log(`  http://${HOST}:${PORT}`);
  console.log(`  Watching ${WATCHLIST.length} pairs`);
  console.log(`  Binance base URL: ${getActiveBaseUrl()}`);
  if (BINANCE_BASE_URLS.length > 1) {
    console.log(`  Failover endpoints: ${BINANCE_BASE_URLS.join(', ')}`);
  }
  console.log('==========================================\n');
});
