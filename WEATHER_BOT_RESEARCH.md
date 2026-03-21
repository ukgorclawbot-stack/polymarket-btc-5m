# Polymarket Weather Trading Bot - Complete Technical Research

## Table of Contents
1. [Architecture Overview](#1-architecture-overview)
2. [Polymarket API Endpoints](#2-polymarket-api-endpoints)
3. [Weather Data Sources & Fetching](#3-weather-data-sources--fetching)
4. [Probability Calculation from Forecasts](#4-probability-calculation-from-forecasts)
5. [Order Placement](#5-order-placement)
6. [Kelly Criterion & Position Sizing](#6-kelly-criterion--position-sizing)
7. [Edge Threshold & Trading Filters](#7-edge-threshold--trading-filters)
8. [Market Resolution Sources](#8-market-resolution-sources)
9. [Wallet & Key Setup](#9-wallet--key-setup)
10. [Weather Market Structure on Polymarket](#10-weather-market-structure-on-polymarket)
11. [Contract Addresses](#11-contract-addresses)
12. [Rate Limits](#12-rate-limits)
13. [Python Dependencies](#13-python-dependencies)
14. [Complete Trading Loop](#14-complete-trading-loop)

---

## 1. Architecture Overview

### Three-Tier Design (suislanchez repo)
```
Data Layer          -->  Signal Layer         -->  Execution Layer
- Open-Meteo GFS       - Ensemble counting       - Kelly sizing
- NWS observations     - Edge calculation         - Order construction
- Gamma API markets     - Threshold filtering      - py-clob-client
```

**Core flow:**
1. Fetch active weather markets from Polymarket Gamma API
2. Parse market titles to extract city, threshold temperature, date, direction
3. Fetch 31-member GFS ensemble forecast from Open-Meteo for that city/date
4. Count ensemble members above/below threshold = model probability
5. Compare model probability to market price = edge
6. If edge > threshold, size with Kelly criterion and place order

### Key Repos Analyzed
- **suislanchez/polymarket-kalshi-weather-bot**: Full Python/FastAPI implementation with GFS ensemble, dual-platform (Polymarket + Kalshi), simulation mode. Most complete reference.
- **solship/Polymarket-Weather-Trading-Bot**: TypeScript/Node.js, NWS integration, simpler structure. Closed source core.
- **Polymarket/agents**: Official LLM-driven trading framework. Shows py-clob-client integration, order execution, USDC approvals.

---

## 2. Polymarket API Endpoints

### Gamma API (Market Data) - `https://gamma-api.polymarket.com`
```
GET /events                              # List events (contains markets)
GET /events?slug={slug}                  # Get event by slug
GET /events/slug/{slug}                  # Get event by slug (path)
GET /events?tag=Weather&active=true&closed=false&limit=100  # Weather markets
GET /events?active=true&closed=false&limit=100&offset=0     # Paginated
GET /markets                             # List markets
GET /markets/{id}                        # Get market by ID
GET /markets?clob_token_ids={token_id}   # Get market by token ID
GET /tags                                # Available categories
```

**Key query params:** `active`, `closed`, `archived`, `limit`, `offset`, `order` (volume_24hr, liquidity), `ascending`, `tag_id`, `slug_contains`

### CLOB API (Trading) - `https://clob.polymarket.com`
```
# Authentication
POST /auth/api-key                       # Create API key (L1 auth)
GET  /auth/derive-api-key                # Derive existing key (L1 auth)

# Market Data
GET  /book?token_id={id}                 # Order book
GET  /price?token_id={id}                # Current price
GET  /midpoint?token_id={id}             # Midpoint price
GET  /spread?token_id={id}               # Spread
GET  /tick-size?token_id={id}            # Tick size
GET  /prices-history?...                 # Price history

# Trading (L2 auth required)
POST   /order                            # Place single order
POST   /orders                           # Place batch (up to 15)
DELETE /order/{id}                        # Cancel single
DELETE /orders                            # Cancel multiple
DELETE /cancel-all                        # Cancel all
DELETE /cancel-market-orders              # Cancel by market

# Account
GET  /orders                             # Open orders
GET  /trades                             # Trade history
GET  /balance-allowance                  # Balance check
```

### Data API - `https://data-api.polymarket.com`
```
GET /trades                              # Trade history
GET /positions                           # Current positions
GET /closed-positions                    # Closed positions
```

### WebSocket - `wss://ws-subscriptions-clob.polymarket.com/ws/market`
```json
// Subscribe (no auth needed for market channel)
{
  "assets_ids": ["token_id_1", "token_id_2"],
  "type": "market"
}
// Message types: book, price_change, last_trade_price, best_bid_ask
// Heartbeat: send "PING" every 10s, receive "PONG"
```

---

## 3. Weather Data Sources & Fetching

### Open-Meteo Ensemble API (Primary - FREE, no auth)
```
GET https://ensemble-api.open-meteo.com/v1/ensemble
  ?latitude={lat}
  &longitude={lon}
  &daily=temperature_2m_max,temperature_2m_min
  &temperature_unit=fahrenheit
  &start_date={YYYY-MM-DD}
  &end_date={YYYY-MM-DD}
  &models=gfs_seamless
```

**Returns 31 GFS ensemble members** as separate keys:
- `temperature_2m_max` (control run)
- `temperature_2m_max_member01` through `temperature_2m_max_member30`
- Same pattern for `temperature_2m_min`

**City configurations used:**
```python
CITY_CONFIG = {
    "nyc":         {"lat": 40.7128, "lon": -74.0060, "nws_station": "KNYC"},
    "chicago":     {"lat": 41.8781, "lon": -87.6298, "nws_station": "KORD"},
    "miami":       {"lat": 25.7617, "lon": -80.1918, "nws_station": "KMIA"},
    "los_angeles": {"lat": 34.0522, "lon": -118.2437, "nws_station": "KLAX"},
    "denver":      {"lat": 39.7392, "lon": -104.9903, "nws_station": "KDEN"},
}
```

**Cache:** 15-minute TTL per (city, date) pair.

### NWS API (Settlement verification)
```
GET https://api.weather.gov/stations/{station}/observations
  ?start={ISO8601}
  &end={ISO8601}
Headers: User-Agent: (trading-bot, contact@example.com)
```
Returns observed temperatures in Celsius; convert to Fahrenheit: `F = C * 9/5 + 32`

### Weather Underground (Polymarket Resolution Source)
Polymarket weather markets resolve using Weather Underground data:
```
https://www.wunderground.com/history/daily/{country}/{city}/{station_code}
```
Example: `https://www.wunderground.com/history/daily/kr/incheon/RKSI`

---

## 4. Probability Calculation from Forecasts

### Non-parametric ensemble counting:
```python
def probability_high_above(threshold_f: float) -> float:
    """Fraction of ensemble members with daily high above threshold."""
    count = sum(1 for h in member_highs if h > threshold_f)
    return count / len(member_highs)  # 31 members typically
```

### Probability clipping (avoid extreme bets):
```python
model_yes_prob = max(0.05, min(0.95, model_yes_prob))
```

### Confidence metric (ensemble agreement):
```python
above_count = sum(1 for m in members if m > threshold_f)
agreement_frac = max(above_count, len(members) - above_count) / len(members)
confidence = min(0.9, agreement_frac)
```

### Example:
- Market: "Will NYC high exceed 75F on March 20?"
- Ensemble: 26 of 31 members predict high > 75F
- Model probability: 26/31 = 83.9%
- Market price (YES): 72 cents
- Edge: 83.9% - 72% = +11.9% --> BUY YES

---

## 5. Order Placement

### py-clob-client Setup
```python
from py_clob_client.client import ClobClient
from py_clob_client.clob_types import ApiCreds, OrderArgs, MarketOrderArgs, OrderType
from py_clob_client.order_builder.constants import BUY, SELL

# Initialize
client = ClobClient(
    host="https://clob.polymarket.com",
    chain_id=137,  # Polygon
    key=os.getenv("PRIVATE_KEY"),
    signature_type=0,  # 0=EOA, 1=POLY_PROXY, 2=GNOSIS_SAFE
)

# Derive API credentials (one-time, cache these)
creds = client.create_or_derive_api_creds()
client.set_api_creds(creds)
```

### Place Limit Order (GTC)
```python
response = client.create_and_post_order(
    OrderArgs(
        token_id="TOKEN_ID_FROM_GAMMA_API",
        price=0.50,
        size=100,       # number of shares
        side=BUY,
    ),
    options={"tick_size": "0.001", "neg_risk": True},  # weather = neg_risk
    order_type=OrderType.GTC
)
# response: {"orderID": "...", "status": "live"|"matched"}
```

### Place Market Order (FOK)
```python
signed_order = client.create_market_order(
    MarketOrderArgs(
        token_id="TOKEN_ID",
        amount=50,       # dollar amount for BUY, share count for SELL
    ),
    options={"tick_size": "0.001", "neg_risk": True}
)
resp = client.post_order(signed_order, orderType=OrderType.FOK)
```

### Batch Orders (up to 15)
```python
from py_clob_client.clob_types import PostOrdersArgs

response = client.post_orders([
    PostOrdersArgs(
        order=client.create_order(
            OrderArgs(price=0.48, size=500, side=BUY, token_id="TOKEN_ID"),
            options={"tick_size": "0.001", "neg_risk": True}
        ),
        orderType=OrderType.GTC,
    ),
])
```

### Order Types
| Type | Behavior | Use Case |
|------|----------|----------|
| GTC  | Rests on book until filled/cancelled | Default limit orders |
| GTD  | Active until specified expiration time | Pre-event expiry |
| FOK  | Must fill entirely immediately or cancel | Market orders |
| FAK  | Fill available amount, cancel rest | Partial market orders |

### USDC Approval (Required once before trading)
```python
from web3 import Web3
from web3.constants import MAX_INT

w3 = Web3(Web3.HTTPProvider("https://polygon-rpc.com"))
usdc = w3.eth.contract(address="0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", abi=ERC20_ABI)
ctf = w3.eth.contract(address="0x4D97DCd97eC945f40cF65F87097ACe5EA0476045", abi=ERC1155_ABI)

# Approve CTF Exchange to spend USDC
txn = usdc.functions.approve(
    "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E", int(MAX_INT, 0)
).build_transaction({"chainId": 137, "from": address, "nonce": nonce})
signed = w3.eth.account.sign_transaction(txn, private_key=key)
w3.eth.send_raw_transaction(signed.raw_transaction)

# Approve CTF Exchange to transfer conditional tokens
txn = ctf.functions.setApprovalForAll(
    "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E", True
).build_transaction({"chainId": 137, "from": address, "nonce": nonce})

# ALSO approve Neg Risk CTF Exchange (for weather multi-outcome markets)
# USDC approval for 0xC5d563A36AE78145C45a50134d48A1215220f80a
# CTF setApprovalForAll for 0xC5d563A36AE78145C45a50134d48A1215220f80a
# USDC approval for Neg Risk Adapter: 0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296
# CTF setApprovalForAll for Neg Risk Adapter: 0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296
```

---

## 6. Kelly Criterion & Position Sizing

### Formula
```python
def calculate_kelly_size(edge, probability, market_price, direction, bankroll):
    if direction == "up":  # or "yes"
        win_prob = probability
        price = market_price
    else:  # "down" or "no"
        win_prob = 1 - probability
        price = 1 - market_price

    odds = (1 - price) / price       # payout ratio
    lose_prob = 1 - win_prob
    kelly = (win_prob * odds - lose_prob) / odds

    kelly *= KELLY_FRACTION           # fractional Kelly (0.15 = 15%)
    kelly = min(kelly, 0.05)          # cap at 5% of bankroll
    kelly = max(kelly, 0)

    size = kelly * bankroll
    size = min(size, MAX_TRADE_SIZE)  # hard cap per trade
    return size
```

### Parameters
| Parameter | BTC Markets | Weather Markets |
|-----------|-------------|-----------------|
| KELLY_FRACTION | 0.15 (15%) | 0.15 (15%) |
| MAX_TRADE_SIZE | $75 | $100 |
| Bankroll cap/trade | 5% | 5% |
| Daily loss limit | $300 | $300 |
| Max open positions | 20 | 20 |

---

## 7. Edge Threshold & Trading Filters

### Edge Calculation
```python
def calculate_edge(model_prob, market_price):
    up_edge = model_prob - market_price
    down_edge = (1 - model_prob) - (1 - market_price)
    if up_edge >= down_edge:
        return up_edge, "up"    # BUY YES
    else:
        return down_edge, "down"  # BUY NO
```

### Thresholds
| Filter | BTC Markets | Weather Markets |
|--------|-------------|-----------------|
| Min edge | 2% (0.02) | 8% (0.08) |
| Max entry price | 55 cents | 70 cents |
| Min volume | $100 | - |

### Why 8% for Weather
Weather forecasts have genuine information advantage over market prices, so a higher threshold ensures only high-conviction trades while accounting for forecast uncertainty.

### Additional Filters (solship repo)
```
ENTRY_THRESHOLD=0.15
EXIT_THRESHOLD=0.45
MIN_HOURS_TO_RESOLUTION=2
MAX_TRADES_PER_RUN=configurable
LOCATIONS=nyc,chicago,miami,dallas,seattle,atlanta
```

---

## 8. Market Resolution Sources

### Polymarket Weather Markets
- **Primary**: Weather Underground historical data
- Example: `https://www.wunderground.com/history/daily/kr/incheon/RKSI`
- Resolution: highest temperature recorded for all times on the specified day
- Precision: whole degrees (Celsius or Fahrenheit depending on market)
- Markets cannot resolve until all data for the date has been finalized
- Revisions after finalization are NOT considered

### Settlement Logic (checking via API)
```python
async def fetch_polymarket_resolution(market_id, event_slug=None):
    # Check Gamma API for market closure and outcome
    response = await client.get(
        f"https://gamma-api.polymarket.com/events?slug={event_slug}"
    )
    market = events[0]["markets"][0]

    if market["closed"]:
        outcome_prices = json.loads(market["outcomePrices"])
        if float(outcome_prices[0]) > 0.99:
            return True, 1.0   # YES/first outcome won
        elif float(outcome_prices[0]) < 0.01:
            return True, 0.0   # NO/second outcome won
    return False, None
```

### P&L Calculation
```python
def calculate_pnl(trade, settlement_value):
    if direction == "yes":
        if settlement_value == 1.0:  # WIN
            pnl = size * (1.0 - entry_price)
        else:  # LOSS
            pnl = -size * entry_price
    else:  # "no"
        if settlement_value == 0.0:  # WIN
            pnl = size * (1.0 - entry_price)
        else:  # LOSS
            pnl = -size * entry_price
```

---

## 9. Wallet & Key Setup

### What You Need
1. **Polygon wallet private key** (hex string, 64 chars)
2. **USDC.e on Polygon** (for trading)
3. **POL on Polygon** (for gas, if using EOA wallet type 0)

### Environment Variables
```bash
# Required
PRIVATE_KEY=0x...              # Polygon wallet private key
# or
POLYGON_WALLET_PRIVATE_KEY=0x...

# Optional (for proxy wallets)
FUNDER_ADDRESS=0x...           # Proxy wallet address
API_KEY=...                    # Derived API key (cached)
SECRET=...                     # Derived secret (cached)
PASSPHRASE=...                 # Derived passphrase (cached)

# For Kalshi (optional dual-platform)
KALSHI_API_KEY_ID=...
KALSHI_PRIVATE_KEY_PATH=...
```

### Signature Types
| Type | Description | Gas |
|------|-------------|-----|
| 0 | EOA (direct wallet) | You pay POL |
| 1 | POLY_PROXY (Magic Link export) | Gasless via relayer |
| 2 | GNOSIS_SAFE (browser wallet) | Gasless via relayer |

### Authentication Flow
```python
# 1. L1: Private key signs EIP-712 message to prove ownership
# 2. Derives API credentials: {apiKey, secret, passphrase}
# 3. L2: All subsequent requests use HMAC-SHA256 with these credentials

# Required headers for L2 requests:
# POLY_ADDRESS: wallet address
# POLY_API_KEY: API key
# POLY_PASSPHRASE: passphrase
# POLY_SIGNATURE: HMAC-SHA256 signature
# POLY_TIMESTAMP: Unix timestamp
```

---

## 10. Weather Market Structure on Polymarket

### Real Example (Seoul, March 17, 2026)
```json
{
  "title": "Highest temperature in Seoul on March 17?",
  "negRisk": true,
  "negRiskMarketID": "0x53631db5d0ccd364579b52253a8e179ef6a84331db36798d362bc28239f6b600",
  "markets": [
    {
      "question": "Will the highest temperature in Seoul be 3C or below on March 17?",
      "groupItemTitle": "3C or below",
      "clobTokenIds": "[\"75401...\", \"29590...\"]",
      "orderPriceMinTickSize": 0.001,
      "orderMinSize": 5,
      "negRisk": true,
      "outcomePrices": "[\"0\", \"1\"]",
      "resolutionSource": "https://www.wunderground.com/history/daily/kr/incheon/RKSI"
    },
    {
      "question": "Will the highest temperature in Seoul be 8C on March 17?",
      "groupItemTitle": "8C",
      "groupItemThreshold": "5",
      "negRisk": true
    }
    // ... more temperature buckets
  ]
}
```

### Key Properties
- **negRisk: true** -- Weather markets are multi-outcome (multiple temperature buckets)
- **Must use Neg Risk CTF Exchange** for order placement
- **orderPriceMinTickSize: 0.001** -- Prices in 0.1 cent increments
- **orderMinSize: 5** -- Minimum 5 shares per order
- **clobTokenIds** -- Array of [YES_token_id, NO_token_id]
- **resolutionSource** -- Weather Underground URL used for resolution

### Finding Weather Markets
```python
# Method 1: Tag-based search
response = httpx.get(
    "https://gamma-api.polymarket.com/events",
    params={"tag": "Weather", "active": "true", "closed": "false", "limit": 100}
)

# Method 2: Slug-based search
response = httpx.get(
    "https://gamma-api.polymarket.com/events",
    params={"slug_contains": "temperature", "closed": "false", "limit": 100}
)

# Method 3: Title parsing patterns
# "Highest temperature in {city} on {date}?"
# "Will the high temperature in {city} exceed {X}F on {date}?"
```

---

## 11. Contract Addresses (Polygon Mainnet, Chain ID 137)

| Contract | Address |
|----------|---------|
| CTF Exchange | `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E` |
| Neg Risk CTF Exchange | `0xC5d563A36AE78145C45a50134d48A1215220f80a` |
| Neg Risk Adapter | `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296` |
| Conditional Tokens (CTF) | `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045` |
| USDC.e (Bridged USDC) | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |
| UMA CTF Adapter | `0x6A9D222616C90FcA5754cd1333cFD9b7fb6a4F74` |
| UMA Optimistic Oracle | `0xCB1822859cEF82Cd2Eb4E6276C7916e692995130` |

---

## 12. Rate Limits

### Gamma API
- General: 4,000 req/10s
- `/events`: 500 req/10s
- `/markets`: 300 req/10s

### CLOB API
- General: 9,000 req/10s
- Order book/price/midpoint: 1,500 req/10s each
- `POST /order`: 3,500 burst/10s; 36,000 sustained/10 min
- `DELETE /order`: 3,000 burst/10s; 30,000 sustained/10 min
- Batch orders: 1,000 burst/10s

### Data API
- General: 1,000 req/10s
- Positions/trades: 150-200 req/10s

---

## 13. Python Dependencies

### Core (from suislanchez repo)
```
fastapi==0.109.0
uvicorn[standard]==0.27.0
sqlalchemy==2.0.25
pydantic==2.5.3
pydantic-settings==2.1.0
httpx==0.26.0
aiohttp==3.9.1
numpy==1.26.3
pandas==2.1.4
scipy==1.12.0
apscheduler==3.10.4
python-dotenv==1.0.0
cryptography>=42.0.0        # For Kalshi RSA-PSS auth
```

### For Trading (from Polymarket agents repo)
```
py-clob-client               # Polymarket CLOB client
python-order-utils           # Order building & signing
web3                         # Polygon interaction
```

### Full Trading Bot Requirements
```
py-clob-client
python-order-utils
web3
httpx
numpy
python-dotenv
apscheduler                  # or schedule, for periodic scanning
```

---

## 14. Complete Trading Loop

```
Every 5 minutes:
  1. FETCH MARKETS
     GET https://gamma-api.polymarket.com/events?tag=Weather&active=true&closed=false
     Parse each market title -> extract city, threshold, date, direction, metric

  2. FETCH FORECASTS (for each market's city/date)
     GET https://ensemble-api.open-meteo.com/v1/ensemble?lat=X&lon=Y&...
     Collect 31 member temperature predictions

  3. CALCULATE PROBABILITIES
     model_prob = count(members > threshold) / 31
     model_prob = clip(model_prob, 0.05, 0.95)

  4. CALCULATE EDGE
     edge = model_prob - market_yes_price  (for YES direction)
     or edge = (1-model_prob) - market_no_price  (for NO direction)

  5. FILTER
     - |edge| >= 0.08 (8% minimum)
     - entry_price <= 0.70
     - market not closed
     - target date in the future

  6. SIZE POSITION (Kelly)
     odds = (1 - price) / price
     kelly = (win_prob * odds - lose_prob) / odds
     size = kelly * 0.15 * bankroll
     size = min(size, $100, bankroll * 0.05)

  7. PLACE ORDER
     client.create_and_post_order(
       OrderArgs(token_id=TOKEN_ID, price=entry_price, size=shares, side=BUY),
       options={"tick_size": "0.001", "neg_risk": True},
       order_type=OrderType.GTC
     )

  8. MONITOR & SETTLE
     Check market closure via Gamma API
     If outcomePrices[0] > 0.99 -> YES won
     If outcomePrices[0] < 0.01 -> NO won
     Calculate P&L: win = size * (1 - entry_price), loss = -size * entry_price
```

---

## Sources
- https://github.com/suislanchez/polymarket-kalshi-weather-bot (full source code analyzed)
- https://github.com/solship/Polymarket-Weather-Trading-Bot (README analyzed)
- https://github.com/Polymarket/agents (full source code analyzed)
- https://docs.polymarket.com/ (complete API docs analyzed)
- Live Gamma API queries for real weather market structure
