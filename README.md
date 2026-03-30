# 🚀 Futures Signal Scanner Pro
Aplikasi signal trading Binance Futures — **30 koin**, **7 indikator teknikal**, entry/TP/SL otomatis.
http://obinance.alwaysdata.net/
---

## 📦 Fitur Lengkap

### Indikator Teknikal
| Indikator | Keterangan |
|-----------|------------|
| RSI (14) | Relative Strength Index — oversold/overbought |
| RSI (7) | RSI cepat untuk konfirmasi |
| MACD | Moving Average Convergence Divergence |
| EMA 20/50/200 | Trend jangka pendek, menengah, panjang |
| Bollinger Bands | Volatilitas & squeeze detection |
| Stochastic RSI | Momentum overbought/oversold presisi tinggi |
| ATR (14) | Average True Range — untuk hitung SL/TP |
| VWAP | Volume Weighted Average Price |

### Signal Engine
- **Score system** (-12 hingga +12): setiap indikator berkontribusi ke skor
- **6 level signal**: STRONG LONG / LONG / WEAK LONG / WEAK SHORT / SHORT / STRONG SHORT
- **Confidence %**: estimasi kepercayaan berdasarkan skor
- **Entry, TP1, TP2, TP3, Stop Loss** otomatis (berbasis ATR)
- **Risk:Reward ratio** otomatis

### Koin yang Di-scan (30 pairs)
```
BTC ETH BNB SOL XRP DOGE ADA AVAX DOT LINK
MATIC NEAR APT ARB OP INJ SUI SEI TIA WIF
UNI AAVE MKR CRV LDO ATOM ALGO FTM HBAR ICP
```

### Data dari Binance API
- Klines (candlestick) — hingga 200 candle
- Ticker 24h (harga, volume, change)
- Funding Rate (setiap 8 jam)
- Open Interest
- Mark Price & Index Price

---

## 🛠️ Setup Backend Node.js

### 1. Install dependencies
```bash
cd backend
npm install
```

### 2. Jalankan server
```bash
npm start
# atau untuk development dengan auto-reload:
npm run dev
```

Server berjalan di: `http://localhost:3000`

### Jika muncul `ECONNREFUSED` ke Binance
Backend ini mengambil data dari Binance Futures di `https://fapi.binance.com`.
Kalau jaringan, firewall, DNS, proxy, atau ISP memblokir endpoint itu, scanner akan gagal walaupun server lokal sudah jalan.

Anda bisa override endpoint dengan file `.env` di folder `backend`:

```bash
cd backend
copy .env.example .env
```

Isi `.env` minimal:

```env
PORT=3000
BINANCE_BASE_URL=https://fapi.binance.com
```

Atau kalau Anda punya endpoint alternatif / proxy sendiri:

```env
BINANCE_BASE_URLS=https://fapi.binance.com,https://your-proxy.example.com
```

Lalu restart backend.

---

## 🐍 Alternatif: Setup Backend Python

### 1. Install dependencies
```bash
pip install fastapi uvicorn binance-futures-connector pandas numpy
```

### 2. Jalankan server
```bash
cd backend
uvicorn main:app --host 0.0.0.0 --port 3000 --reload
```

---

## 🌐 Buka Frontend

Setelah backend berjalan, buka browser:
```
http://localhost:3000
```

Atau buka file langsung:
```
frontend/public/index.html
```
(Note: jika buka langsung tanpa server, CORS akan blokir API call)

---

## 🔌 API Endpoints

| Endpoint | Method | Deskripsi |
|----------|--------|-----------|
| `/api/health` | GET | Cek status server |
| `/api/scanner?interval=1h` | GET | Scan semua 30 pair |
| `/api/analyze/BTCUSDT?interval=1h` | GET | Analisis detail 1 pair |
| `/api/opportunities` | GET | Top signal terkuat |
| `/api/funding` | GET | Funding rates semua pair |
| `/api/openinterest` | GET | Open interest top 15 |
| `/api/klines/BTCUSDT?interval=1h` | GET | Raw klines data |
| `/api/watchlist` | GET | Daftar semua pair |

---

## 📊 Cara Baca Signal

### Score System
```
+10 s/d +12  → STRONG LONG  (kepercayaan ~90%+)
+4  s/d +9   → LONG         (kepercayaan ~70-85%)
+1  s/d +3   → WEAK LONG    (konfirmasi diperlukan)
 0            → NETRAL
-1  s/d -3   → WEAK SHORT
-4  s/d -9   → SHORT
-10 s/d -12  → STRONG SHORT
```

### Kontribusi Score per Indikator
```
RSI < 30          → +3 poin (oversold kuat)
RSI 30-40         → +2 poin
MACD bullish      → +2 poin
MACD histogram +  → +1 poin
EMA20 > EMA50     → +2 poin (uptrend)
EMA50 > EMA200    → +1 poin (bull market)
Harga < BB lower  → +3 poin (sangat oversold)
BB Squeeze        → +1 poin
StochRSI < 20     → +2 poin
Harga > VWAP      → +1 poin
Funding negatif   → +2 poin (peluang short squeeze)
```

### Entry/TP/SL Formula (berbasis ATR)
```
LONG:
  Entry = Harga saat ini
  TP1   = Entry + (ATR × 1.5)
  TP2   = Entry + (ATR × 3.0)   ← target utama
  TP3   = Entry + (ATR × 5.0)
  SL    = Entry - (ATR × 1.0)

SHORT:
  Entry = Harga saat ini
  TP1   = Entry - (ATR × 1.5)
  TP2   = Entry - (ATR × 3.0)
  TP3   = Entry - (ATR × 5.0)
  SL    = Entry + (ATR × 1.0)
```

---

## ⚠️ Disclaimer

Aplikasi ini **hanya untuk referensi dan edukasi**.
- Selalu gunakan manajemen risiko yang baik
- Jangan trading dengan modal yang tidak sanggup rugi
- Sinyal teknikal tidak 100% akurat
- Past performance ≠ future results

---

## 🔧 Pengembangan Lanjutan

Beberapa fitur yang bisa ditambahkan:
1. **Telegram Bot** — kirim signal otomatis ke grup
2. **Webhook alert** — notifikasi saat signal muncul
3. **Backtesting** — uji akurasi signal di data historis
4. **Auto-order** — eksekusi order otomatis via Binance API (butuh API key)
5. **Database** — simpan riwayat signal (PostgreSQL/MongoDB)
6. **WebSocket** — update harga real-time tanpa refresh

---

## 📁 Struktur File

```
futures-signal-app/
├── backend/
│   ├── server.js      ← Backend Node.js (UTAMA)
│   ├── main.py        ← Alternatif Python/FastAPI
│   └── package.json
└── frontend/
    └── public/
        └── index.html ← Dashboard UI
```
