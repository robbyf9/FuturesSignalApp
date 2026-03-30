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

def generate_signal(indicators: dict, price: float, funding_rate: float):
    score = 0
    reasons = []

    rsi = indicators["rsi"]
    if rsi < 30: score += 3; reasons.append("RSI oversold (<30)")
    elif rsi < 40: score += 2; reasons.append("RSI mendekati oversold")
    elif rsi < 50: score += 1
    elif rsi > 70: score -= 3; reasons.append("RSI overbought (>70)")
    elif rsi > 60: score -= 2; reasons.append("RSI mendekati overbought")

    macd = indicators["macd"]
    if macd["macd"] > macd["signal"]: score += 2; reasons.append("MACD bullish crossover")
    else: score -= 2; reasons.append("MACD bearish crossover")
    if macd["histogram"] > 0: score += 1
    else: score -= 1

    ema20, ema50, ema200 = indicators["ema20"], indicators["ema50"], indicators["ema200"]
    if ema20 > ema50: score += 2; reasons.append("EMA20 > EMA50 (uptrend)")
    else: score -= 2; reasons.append("EMA20 < EMA50 (downtrend)")
    if ema50 > ema200: score += 1; reasons.append("EMA50 > EMA200 (bull market)")
    else: score -= 1

    bb = indicators["bb"]
    if price <= bb["lower"]: score += 3; reasons.append("Harga di bawah BB lower")
    elif price >= bb["upper"]: score -= 3; reasons.append("Harga di atas BB upper")
    if bb["width"] < 5: score += 1; reasons.append("BB squeeze")

    stoch = indicators["stochRSI"]
    if stoch["k"] < 20: score += 2; reasons.append("StochRSI oversold")
    elif stoch["k"] > 80: score -= 2; reasons.append("StochRSI overbought")

    if price > indicators["vwap"]: score += 1; reasons.append("Harga di atas VWAP")
    else: score -= 1; reasons.append("Harga di bawah VWAP")

    if funding_rate < -0.01: score += 2; reasons.append("Funding rate negatif")
    elif funding_rate > 0.05: score -= 2; reasons.append("Funding rate overlevered")

    if score >= 7: signal, strength, conf = "STRONG LONG", "strong", min(95, 60 + score * 3)
    elif score >= 4: signal, strength, conf = "LONG", "long", min(85, 50 + score * 4)
    elif score >= 1: signal, strength, conf = "WEAK LONG", "weaklong", min(65, 40 + score * 5)
    elif score <= -7: signal, strength, conf = "STRONG SHORT", "strong-short", min(95, 60 + abs(score) * 3)
    elif score <= -4: signal, strength, conf = "SHORT", "short", min(85, 50 + abs(score) * 4)
    elif score <= -1: signal, strength, conf = "WEAK SHORT", "weakshort", min(65, 40 + abs(score) * 5)
    else: signal, strength, conf = "NETRAL", "neutral", 50

    atr = indicators["atr"]
    is_long = score > 0
    entry = price
    tp1 = price + atr * 1.5 if is_long else price - atr * 1.5
    tp2 = price + atr * 3 if is_long else price - atr * 3
    tp3 = price + atr * 5 if is_long else price - atr * 5
    sl = price - atr if is_long else price + atr
    rr = abs(tp2 - entry) / abs(sl - entry) if sl != entry else 0

    return {
        "signal": signal,
        "strength": strength,
        "score": score,
        "confidence": round(conf, 1),
        "reasons": reasons[:5],
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

    signal_data = generate_signal(indicators, price, funding_rate)

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
def scanner(interval: str = "1h", min_score: int = 0):
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
                    "reasons": sig["reasons"],
                    "levels": sig["levels"],
                })
            except:
                pass

    results = [r for r in results if abs(r["score"]) >= min_score]
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
