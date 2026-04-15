"""
Binance Futures Signal Scanner - Python Backend
Alternatif backend menggunakan Python + FastAPI

Install:
    pip install fastapi uvicorn binance-futures-connector pandas numpy

Run:
    uvicorn main:app --host 0.0.0.0 --port 3000 --reload
"""

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from binance.um_futures import UMFutures
import numpy as np
import pandas as pd
from typing import Optional
import asyncio
from concurrent.futures import ThreadPoolExecutor

app = FastAPI(title="Futures Signal Scanner")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Inisialisasi client (tanpa API key untuk data publik)
client = UMFutures()

WATCHLIST = [
    # Large caps
    "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT",
    # Mid caps volatilitas tinggi
    "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "DOTUSDT", "LINKUSDT",
    "MATICUSDT", "NEARUSDT", "APTUSDT", "ARBUSDT", "OPUSDT",
    "INJUSDT", "SUIUSDT", "SEIUSDT", "TIAUSDT", "WIFUSDT",
    # DeFi
    "UNIUSDT", "AAVEUSDT", "MKRUSDT", "CRVUSDT", "LDOUSDT",
    # Layer 1
    "ATOMUSDT", "ALGOUSDT", "FTMUSDT", "HBARUSDT", "ICPUSDT",
]


# ─── Indikator Teknikal ─────────────────────────────────────────────────────────

def calc_rsi(closes: pd.Series, period: int = 14) -> float:
    delta = closes.diff()
    gain = delta.where(delta > 0, 0)
    loss = -delta.where(delta < 0, 0)
    avg_gain = gain.rolling(period).mean().iloc[-1]
    avg_loss = loss.rolling(period).mean().iloc[-1]
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return round(100 - (100 / (1 + rs)), 2)


def calc_ema(closes: pd.Series, period: int) -> float:
    return round(closes.ewm(span=period, adjust=False).mean().iloc[-1], 6)


def calc_macd(closes: pd.Series):
    ema12 = closes.ewm(span=12, adjust=False).mean()
    ema26 = closes.ewm(span=26, adjust=False).mean()
    macd_line = ema12 - ema26
    signal_line = macd_line.ewm(span=9, adjust=False).mean()
    histogram = macd_line - signal_line
    return {
        "macd": round(macd_line.iloc[-1], 6),
        "signal": round(signal_line.iloc[-1], 6),
        "histogram": round(histogram.iloc[-1], 6),
    }


def calc_bollinger(closes: pd.Series, period: int = 20, std_dev: float = 2):
    middle = closes.rolling(period).mean().iloc[-1]
    std = closes.rolling(period).std().iloc[-1]
    upper = middle + std_dev * std
    lower = middle - std_dev * std
    width = ((upper - lower) / middle) * 100
    return {
        "upper": round(upper, 6),
        "middle": round(middle, 6),
        "lower": round(lower, 6),
        "width": round(width, 2),
    }


def calc_stoch_rsi(closes: pd.Series, rsi_period=14, stoch_period=14):
    rsi = closes.rolling(rsi_period + 1).apply(
        lambda x: calc_rsi(pd.Series(x), rsi_period), raw=False
    )
    min_rsi = rsi.rolling(stoch_period).min()
    max_rsi = rsi.rolling(stoch_period).max()
    stoch_k = 100 * (rsi - min_rsi) / (max_rsi - min_rsi + 1e-10)
    stoch_d = stoch_k.rolling(3).mean()
    return {
        "k": round(stoch_k.iloc[-1], 2),
        "d": round(stoch_d.iloc[-1], 2),
    }


def calc_atr(df: pd.DataFrame, period: int = 14) -> float:
    high = df["high"]
    low = df["low"]
    close = df["close"]
    tr = pd.concat([
        high - low,
        (high - close.shift()).abs(),
        (low - close.shift()).abs()
    ], axis=1).max(axis=1)
    return round(tr.rolling(period).mean().iloc[-1], 6)


def calc_vwap(df: pd.DataFrame) -> float:
    typical = (df["high"] + df["low"] + df["close"]) / 3
    vwap = (typical * df["volume"]).sum() / df["volume"].sum()
    return round(vwap, 6)


# ─── Signal Engine ──────────────────────────────────────────────────────────────

def validate_trend(df: pd.DataFrame, period_short=5, period_long=20):
    """Validasi trend strength dengan multiple confirmations"""
    closes = df["close"]
    ema_short = closes.ewm(span=period_short, adjust=False).mean()
    ema_long = closes.ewm(span=period_long, adjust=False).mean()
    
    current = closes.iloc[-1]
    ema_s = ema_short.iloc[-1]
    ema_l = ema_long.iloc[-1]
    prev_close = closes.iloc[-2]
    
    # Hitung momentum
    momentum = ((current - prev_close) / prev_close) * 100
    
    return {
        "is_uptrend": ema_s > ema_l,
        "ema_spread": ((ema_s - ema_l) / ema_l) * 100,
        "momentum": momentum,
        "is_strong_uptrend": ema_s > ema_l and momentum > 0.1,
        "is_strong_downtrend": ema_s < ema_l and momentum < -0.1,
    }

def check_volume_strength(df: pd.DataFrame):
    """Validasi volume untuk confirm signal"""
    volumes = df["volume"]
    current_vol = volumes.iloc[-1]
    avg_vol = volumes.iloc[-20:-1].mean()
    vol_ratio = current_vol / avg_vol if avg_vol > 0 else 0
    return round(vol_ratio, 2)

def validate_candle_pattern(df: pd.DataFrame):
    """Detect valid candle patterns untuk entry"""
    closes = df["close"]
    opens = df["open"]
    highs = df["high"]
    lows = df["low"]
    
    # Current candle
    curr_open = opens.iloc[-1]
    curr_close = closes.iloc[-1]
    curr_high = highs.iloc[-1]
    curr_low = lows.iloc[-1]
    
    # Previous candle
    prev_close = closes.iloc[-2]
    prev_open = opens.iloc[-2]
    
    body_size = abs(curr_close - curr_open)
    wick_upper = curr_high - max(curr_open, curr_close)
    wick_lower = min(curr_open, curr_close) - curr_low
    
    patterns = {
        "is_hammer": wick_lower > body_size * 2 and wick_upper < body_size,
        "is_reversal": curr_close > prev_close and curr_open < prev_close,
        "is_strong_body": body_size > (curr_high - curr_low) * 0.6,
        "is_bullish_engulf": curr_open < prev_open and curr_close > prev_close,
    }
    
    return patterns

def generate_signal(indicators: dict, price: float, funding_rate: float, df: pd.DataFrame = None):
    score = 0
    reasons = []
    filters_passed = 0
    max_filters = 5

    # FILTER 1: TREND VALIDATION (CRITICAL)
    if df is not None:
        trend_data = validate_trend(df)
        vol_strength = check_volume_strength(df)
        candle_pattern = validate_candle_pattern(df)
        
        # Hanya enter jika EMA alignment strong
        ema20, ema50, ema200 = indicators["ema20"], indicators["ema50"], indicators["ema200"]
        
        # LONG conditions - semua harus aligned
        if ema20 > ema50 > ema200:  # Strong uptrend alignment
            score += 4
            reasons.append("✓ EMA alignment BULLISH (20>50>200)")
            filters_passed += 1
        else:
            score -= 5
            reasons.append("✗ Trend alignment BEARISH")

        # SHORT conditions
        if ema20 < ema50 < ema200:  # Strong downtrend alignment
            score -= 4
            reasons.append("✓ EMA alignment BEARISH (20<50<200)")
            filters_passed += 1

        # FILTER 2: MOMENTUM VALIDATION
        if trend_data["is_strong_uptrend"]:
            score += 3
            reasons.append("✓ Strong uptrend momentum")
            filters_passed += 1
        elif trend_data["is_strong_downtrend"]:
            score -= 3
            reasons.append("✓ Strong downtrend momentum")

        # FILTER 3: VOLUME CONFIRMATION
        if vol_strength > 1.3:  # Volume harus 30% di atas rata-rata
            score += 2
            reasons.append(f"✓ Volume strong ({vol_strength:.1f}x avg)")
            filters_passed += 1
        elif vol_strength < 0.7:
            score -= 2
            reasons.append(f"✗ Volume weak ({vol_strength:.1f}x avg)")

        # FILTER 4: CANDLE PATTERN
        if candle_pattern["is_bullish_engulf"] or candle_pattern["is_hammer"]:
            score += 2
            reasons.append("✓ Bullish candle pattern")
            filters_passed += 1
        elif candle_pattern["is_reversal"] and candle_pattern["is_strong_body"]:
            score += 1
            reasons.append("✓ Potential reversal pattern")

    # RSI - lebih ketat
    rsi = indicators["rsi"]
    if rsi < 25:
        score += 2
        reasons.append("RSI deeply oversold")
    elif rsi < 35:
        score += 1
        reasons.append("RSI oversold")
    elif rsi > 75:
        score -= 2
        reasons.append("RSI deeply overbought")
    elif rsi > 65:
        score -= 1
        reasons.append("RSI overbought")

    # MACD - hanya strong confirmation
    macd = indicators["macd"]
    if macd["macd"] > macd["signal"] and macd["histogram"] > 0:
        score += 2
        reasons.append("MACD bullish crossover + positive histogram")
    elif macd["macd"] < macd["signal"] and macd["histogram"] < 0:
        score -= 2
        reasons.append("MACD bearish crossover + negative histogram")

    # Bollinger Bands - extreme conditions only
    bb = indicators["bb"]
    if price <= bb["lower"] and rsi < 35:  # BOTH kondisi harus TRUE
        score += 3
        reasons.append("Price at BB lower + RSI oversold")
    elif price >= bb["upper"] and rsi > 65:
        score -= 3
        reasons.append("Price at BB upper + RSI overbought")

    # StochRSI - strong oversold/overbought
    stoch = indicators["stochRSI"]
    if stoch["k"] < 15 and stoch["d"] < 15:
        score += 2
        reasons.append("StochRSI extremely oversold")
    elif stoch["k"] > 85 and stoch["d"] > 85:
        score -= 2
        reasons.append("StochRSI extremely overbought")

    # VWAP - hanya counted jika strong
    if price > indicators["vwap"] * 1.002:  # Must be 0.2% above
        score += 1
        reasons.append("Price above VWAP")
    elif price < indicators["vwap"] * 0.998:
        score -= 1
        reasons.append("Price below VWAP")

    # Funding Rate - lebih ketat
    if funding_rate < -0.05:
        score += 2
        reasons.append("Funding rate very negative (good for long)")
    elif funding_rate > 0.08:
        score -= 2
        reasons.append("Funding rate too high (risky)")

    # STRICTER SIGNAL THRESHOLD - raised dari 1 ke 6
    if score >= 11: signal, strength, conf = "STRONG LONG", "strong", 95
    elif score >= 8: signal, strength, conf = "LONG", "long", 80
    elif score >= 6: signal, strength, conf = "WEAK LONG", "weaklong", 60
    elif score <= -11: signal, strength, conf = "STRONG SHORT", "strong-short", 95
    elif score <= -8: signal, strength, conf = "SHORT", "short", 80
    elif score <= -6: signal, strength, conf = "WEAK SHORT", "weakshort", 60
    else: signal, strength, conf = "NETRAL", "neutral", 0

    atr = indicators["atr"]
    is_long = score > 0
    entry = price
    
    # Adaptive TP/SL based on volatility
    atr_factor = 2 if atr > indicators["bb"]["width"] * 0.5 else 2.5
    
    tp1 = price + atr * 1.5 * atr_factor if is_long else price - atr * 1.5 * atr_factor
    tp2 = price + atr * 2.5 * atr_factor if is_long else price - atr * 2.5 * atr_factor
    tp3 = price + atr * 4 * atr_factor if is_long else price - atr * 4 * atr_factor
    sl = price - atr * 1.2 if is_long else price + atr * 1.2
    rr = abs(tp2 - entry) / abs(sl - entry) if sl != entry else 0

    return {
        "signal": signal,
        "strength": strength,
        "score": score,
        "confidence": round(conf, 1),
        "filters_passed": filters_passed if df is not None else "N/A",
        "reasons": reasons[:7],
        "levels": {
            "entry": round(entry, 4),
            "tp1": round(tp1, 4),
            "tp2": round(tp2, 4),
            "tp3": round(tp3, 4),
            "sl": round(sl, 4),
            "rr": round(rr, 2),
        },
    }


# ─── Analisis satu pair ──────────────────────────────────────────────────────────

def analyze_pair(symbol: str, interval: str = "1h"):
    klines = client.klines(symbol, interval, limit=200)
    df = pd.DataFrame(klines, columns=[
        "time", "open", "high", "low", "close", "volume",
        "close_time", "quote_volume", "trades", "taker_buy_base",
        "taker_buy_quote", "ignore"
    ])
    for col in ["open", "high", "low", "close", "volume"]:
        df[col] = df[col].astype(float)

    ticker = client.ticker_24hr_price_change(symbol=symbol)
    funding = client.mark_price(symbol=symbol)

    price = float(ticker["lastPrice"])
    funding_rate = float(funding["lastFundingRate"]) * 100

    indicators = {
        "rsi": calc_rsi(df["close"]),
        "rsi7": calc_rsi(df["close"], 7),
        "macd": calc_macd(df["close"]),
        "ema20": calc_ema(df["close"], 20),
        "ema50": calc_ema(df["close"], 50),
        "ema200": calc_ema(df["close"], 200),
        "bb": calc_bollinger(df["close"]),
        "stochRSI": calc_stoch_rsi(df["close"]),
        "atr": calc_atr(df),
        "vwap": calc_vwap(df.tail(24)),
    }

    signal_data = generate_signal(indicators, price, funding_rate, df)

    return {
        "symbol": symbol,
        "interval": interval,
        "market": {
            "price": price,
            "priceChangePercent": float(ticker["priceChangePercent"]),
            "high24h": float(ticker["highPrice"]),
            "low24h": float(ticker["lowPrice"]),
            "volume24h": float(ticker["volume"]),
            "quoteVolume": float(ticker["quoteVolume"]),
            "fundingRate": funding_rate,
            "markPrice": float(funding["markPrice"]),
        },
        "indicators": indicators,
        "signal": signal_data,
    }


# ─── Routes ─────────────────────────────────────────────────────────────────────

@app.get("/api/health")
def health(): return {"status": "ok", "watchlist": len(WATCHLIST)}

@app.get("/api/watchlist")
def watchlist(): return {"pairs": WATCHLIST}

@app.get("/api/analyze/{symbol}")
def analyze(symbol: str, interval: str = "1h"):
    try:
        return analyze_pair(symbol.upper(), interval)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/scanner")
def scanner(interval: str = "1h", min_score: int = 6, min_confidence: int = 60):
    """
    Scanner dengan filter ketat untuk mengurangi false signals:
    - min_score: default 6 (signal harus WEAK LONG/SHORT minimal)
    - min_confidence: default 60% (signal harus valid)
    """
    results = []
    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = {executor.submit(analyze_pair, sym, interval): sym for sym in WATCHLIST}
        for future in futures:
            try:
                data = future.result()
                sig = data["signal"]
                results.append({
                    "symbol": data["symbol"],
                    "price": data["market"]["price"],
                    "priceChangePercent": data["market"]["priceChangePercent"],
                    "fundingRate": data["market"]["fundingRate"],
                    "rsi": data["indicators"]["rsi"],
                    "signal": sig["signal"],
                    "strength": sig["strength"],
                    "score": sig["score"],
                    "confidence": sig["confidence"],
                    "filters_passed": sig["filters_passed"],
                    "reasons": sig["reasons"],
                    "levels": sig["levels"],
                })
            except:
                pass

    # Filter ketat: hanya signal dengan confidence tinggi dan score memenuhi threshold
    results = [
        r for r in results 
        if abs(r["score"]) >= min_score and r["confidence"] >= min_confidence
    ]
    results.sort(key=lambda x: abs(x["score"]), reverse=True)
    return {"count": len(results), "data": results}

@app.get("/api/funding")
def funding_rates():
    data = client.mark_price()
    filtered = [
        {
            "symbol": d["symbol"],
            "markPrice": float(d["markPrice"]),
            "fundingRate": float(d["lastFundingRate"]) * 100,
            "nextFundingTime": d["nextFundingTime"],
        }
        for d in data if d["symbol"] in WATCHLIST
    ]
    filtered.sort(key=lambda x: abs(x["fundingRate"]), reverse=True)
    return filtered
