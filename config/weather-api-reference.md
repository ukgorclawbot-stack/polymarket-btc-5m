# Weather Forecast API Reference for Polymarket Weather Betting

## Table of Contents
1. [Polymarket Weather Market Resolution](#polymarket-weather-market-resolution)
2. [Open-Meteo API (Primary Forecast Source)](#open-meteo-api)
3. [Open-Meteo Ensemble API (Probabilistic Forecasts)](#open-meteo-ensemble-api)
4. [NOAA Weather API (api.weather.gov)](#noaa-weather-api)
5. [Weather Underground (Resolution Source)](#weather-underground)
6. [Visual Crossing (Backup Source)](#visual-crossing)
7. [City Coordinates & Station Reference](#city-coordinates--station-reference)
8. [Python Implementation Examples](#python-implementation-examples)

---

## Polymarket Weather Market Resolution

### How Markets Work
- Markets ask: "Highest temperature in [City] on [Date]?"
- Outcomes are temperature brackets (e.g., "48-49F", "50-51F", "52F or higher")
- Resolution uses **Weather Underground historical data** for specific airport stations
- Markets resolve after all data for the date is finalized
- Post-finalization revisions are NOT considered

### Resolution Sources by City

| City | Station Name | Station ID | WU History URL | Units |
|------|-------------|-----------|----------------|-------|
| NYC | LaGuardia Airport | KLGA | https://www.wunderground.com/history/daily/us/ny/new-york-city/KLGA | Fahrenheit (whole degrees) |
| London | London City Airport | EGLC | https://www.wunderground.com/history/daily/gb/london/EGLC | Fahrenheit (whole degrees) |
| Seoul | Incheon Intl Airport | RKSI | https://www.wunderground.com/history/daily/kr/incheon/RKSI | Celsius (whole degrees) |
| Los Angeles | LAX International | KLAX | https://www.wunderground.com/history/daily/us/ca/los-angeles/KLAX | Fahrenheit (whole degrees) |

### Key Resolution Details
- NYC/London/LA: whole degrees Fahrenheit
- Seoul: whole degrees Celsius
- Resolution = highest temperature recorded at station for ALL times on that date
- NOTE: WU hourly obs may differ from NWS official daily high (known discrepancy source)

### Typical Market Bracket Structure
NYC example (winter): 41F or below, 42-43F, 44-45F, 46-47F, 48-49F, 50-51F, 52-53F, 54-55F, 56F or higher
London example: 54F or below, 55-56F, 57-58F, 59-60F, 61-62F, 63-64F, 65F or higher

---

## Open-Meteo API

### Overview
- Free, open-source weather API
- No API key required for non-commercial use
- 40+ weather models including ECMWF, GFS, HRRR, ICON
- "Best Match" mode auto-selects optimal model per location

### Key Details
| Property | Value |
|----------|-------|
| Base URL | `https://api.open-meteo.com/v1/forecast` |
| Auth | None required (free tier) |
| Rate Limit | 10,000 requests/day (non-commercial) |
| Forecast Range | Up to 16 days |
| Update Frequency | Model-dependent (every 1-6 hours) |
| Response Format | JSON (also CSV, XLSX) |

### Endpoint: Standard Forecast

```
GET https://api.open-meteo.com/v1/forecast
```

**Required Parameters:**
- `latitude` (float) - WGS84 latitude
- `longitude` (float) - WGS84 longitude
- `hourly` and/or `daily` - comma-separated weather variables

**Key Optional Parameters:**
- `temperature_unit` - `celsius` (default) or `fahrenheit`
- `forecast_days` - 0-16, default 7
- `timezone` - IANA timezone string or `auto`
- `models` - specific model(s) to use

**Useful Variables:**

Hourly:
- `temperature_2m` - Air temperature at 2m height
- `precipitation` - Total precipitation (rain + snow)
- `precipitation_probability` - Probability of precipitation
- `apparent_temperature` - Feels-like temperature

Daily:
- `temperature_2m_max` - Daily maximum temperature
- `temperature_2m_min` - Daily minimum temperature
- `temperature_2m_mean` - Daily mean temperature
- `precipitation_sum` - Total daily precipitation
- `precipitation_probability_max` - Max precipitation probability

### JSON Response Structure

```json
{
  "latitude": 40.71,
  "longitude": -73.99,
  "elevation": 10.0,
  "generationtime_ms": 0.5,
  "utc_offset_seconds": -18000,
  "timezone": "America/New_York",
  "hourly_units": {
    "time": "iso8601",
    "temperature_2m": "°F"
  },
  "hourly": {
    "time": ["2026-03-17T00:00", "2026-03-17T01:00", ...],
    "temperature_2m": [35.2, 34.8, ...]
  },
  "daily_units": {
    "time": "iso8601",
    "temperature_2m_max": "°F"
  },
  "daily": {
    "time": ["2026-03-17", "2026-03-18", ...],
    "temperature_2m_max": [52.1, 48.6, ...],
    "temperature_2m_min": [33.4, 31.2, ...]
  }
}
```

---

## Open-Meteo Ensemble API

### Overview
Provides probabilistic forecasts from ensemble models. Each ensemble run perturbs initial conditions slightly, producing a distribution of possible outcomes. Critical for estimating probability of temperature falling in specific Polymarket brackets.

### Key Details
| Property | Value |
|----------|-------|
| Base URL | `https://ensemble-api.open-meteo.com/v1/ensemble` |
| Auth | None required |
| Models | GFS Ensemble 0.25deg (31 members, 10 days), GFS Ensemble 0.5deg (31 members, 35 days) |
| Update Frequency | Every 6 hours |
| Rate Limit | Same 10,000/day free tier |

### Available Ensemble Models
- `gfs_ensemble_025` - 25km resolution, 31 members, 10-day forecast
- `gfs_ensemble_05` - 50km resolution, 31 members, 35-day forecast
- `icon_seamless` - DWD ICON ensemble
- `ecmwf_ifs025` - ECMWF ensemble (51 members)
- `gem_global` - Canadian GEM ensemble

### Basic Ensemble Request

```
GET https://ensemble-api.open-meteo.com/v1/ensemble?latitude=40.71&longitude=-73.99&hourly=temperature_2m&models=gfs_ensemble_025&temperature_unit=fahrenheit
```

Returns all 31 ensemble member temperature traces. Each member is indexed 0-30 (member 0 = control run).

### Probability Queries (p~ syntax)

Calculate probability of conditions directly from ensemble members:

```
# Probability temperature exceeds 50F
hourly=p~temperature_2m~morethan~50

# Probability temperature is less than 40F
hourly=p~temperature_2m~lessthan~40

# Probability temperature >= 48 AND < 50 (for a bracket)
hourly=p~temperature_2m~moreeq~48~lessthan~50

# Probability of precipitation >= 0.3mm
hourly=p~precipitation~moreeq~0.3
```

**Available operators:**
- `morethan` (>)
- `lessthan` (<)
- `moreeq` (>=)
- `lesseq` (<=)
- `eq` (==)

**Dual conditions:** `p~variable~op1~val1~op2~val2` (range queries)

### Quantile/Percentile Queries (q~ syntax)

Get specific percentiles from the ensemble distribution:

```
# 10th percentile (lower bound)
hourly=q~temperature_2m~10

# 25th percentile
hourly=q~temperature_2m~25

# 50th percentile (median)
hourly=q~temperature_2m~50

# 75th percentile
hourly=q~temperature_2m~75

# 90th percentile (upper bound)
hourly=q~temperature_2m~90
```

Combine multiple: `hourly=q~temperature_2m~10,q~temperature_2m~25,q~temperature_2m~50,q~temperature_2m~75,q~temperature_2m~90`

### Validation Rules
- p~ queries must have 4 parts (single condition) or 6 parts (dual condition)
- Dual conditions cannot use the same operator prefix (e.g., both "more")
- Quantile values must be 0-100
- Referenced variables must exist in the API

---

## NOAA Weather API

### Overview
Free, public API from the National Weather Service. No API key required. Provides official US government forecasts. Good for US cities only.

### Key Details
| Property | Value |
|----------|-------|
| Base URL | `https://api.weather.gov` |
| Auth | None required (set User-Agent header recommended) |
| Rate Limit | Reasonable use (no published hard limit) |
| Coverage | United States only |
| Response Format | GeoJSON / JSON-LD |

### Two-Step Workflow

**Step 1: Get grid coordinates for a location**
```
GET https://api.weather.gov/points/{lat},{lon}
```
Response includes `forecastGridData`, `forecast`, and `forecastHourly` URLs.

**Step 2: Get forecast data**

Option A - Human-readable 12h periods:
```
GET https://api.weather.gov/gridpoints/{wfo}/{x},{y}/forecast
```

Option B - Hourly forecast:
```
GET https://api.weather.gov/gridpoints/{wfo}/{x},{y}/forecast/hourly
```

Option C - Raw numerical gridpoint data (BEST for programmatic use):
```
GET https://api.weather.gov/gridpoints/{wfo}/{x},{y}
```

### Raw Gridpoint Data Layers
- `temperature` - Air temperature time series
- `maxTemperature` - Daily high temperature
- `minTemperature` - Daily low temperature
- `apparentTemperature` - Feels-like
- `probabilityOfPrecipitation` - Precip probability
- `quantitativePrecipitation` - Precip amount

### Time Series Format
Each data point:
```json
{
  "validTime": "2026-03-17T18:00:00+00:00/PT3H",
  "value": 12.2
}
```
- `validTime` is ISO 8601 with duration (PT3H = 3-hour period)
- Consecutive equal values are merged to save bandwidth
- Temperature values in Celsius by default; use `?units=us` for Fahrenheit

### Query Parameters
- `units` - `us` (imperial) or `si` (metric)

### Headers
Set `User-Agent` to identify your application (required by NOAA policy):
```
User-Agent: (myweatherapp.com, contact@myweatherapp.com)
```

---

## Weather Underground

### Overview
Resolution source for Polymarket weather markets. The original free API was discontinued in 2018 after IBM acquisition. Current access requires either a PWS Contributor API key or web scraping.

### PWS Contributor API (requires owning a weather station)

```
GET https://api.weather.com/v2/pws/observations/current?stationId={stationId}&format=json&units=e&apiKey={apiKey}
```

```
GET https://api.weather.com/v2/pws/history/daily?stationId={stationId}&format=json&units=e&startDate=20260317&apiKey={apiKey}
```

- API key: 32-character string, one per account
- Requires registering a PWS with Weather Underground
- `units=e` for imperial (Fahrenheit), `units=m` for metric

### Web History Page (for resolution verification)

URL pattern:
```
https://www.wunderground.com/history/daily/{country_path}/{station_id}/date/{YYYY-M-D}
```

Examples:
```
https://www.wunderground.com/history/daily/us/ny/new-york-city/KLGA/date/2026-3-17
https://www.wunderground.com/history/daily/gb/london/EGLC/date/2026-3-17
https://www.wunderground.com/history/daily/kr/incheon/RKSI/date/2026-3-17
```

### Scraping Approach (Selenium required)
WU renders data client-side with JavaScript. Scraping requires a headless browser.
Dashboard URL pattern:
```
https://www.wunderground.com/dashboard/pws/{STATION_ID}/table/{DATE}/{DATE}/daily
```

Data is inside `<lib-history-table>` elements with `<tbody>` for times and values.
Fields: Temperature, Dew Point, Humidity, Wind Speed, Wind Gust, Pressure, Precip Rate, Precip Accum.

---

## Visual Crossing

### Overview
Commercial weather API with a free tier. Good backup/validation source. Handles both historical and forecast data seamlessly.

### Key Details
| Property | Value |
|----------|-------|
| Base URL | `https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/` |
| Auth | API key required (free signup) |
| Free Tier | 1,000 records/day |
| Forecast Range | 15 days |
| Response Format | JSON, CSV |

### Endpoint Pattern
```
GET /timeline/{location}?key={API_KEY}
GET /timeline/{location}/{date1}/{date2}?key={API_KEY}
```

`{location}` can be: city name, address, coordinates, or ZIP code.

### Key Parameters
- `unitGroup` - `us`, `uk`, `metric`, or `base`
- `include` - `days`, `hours`, `current`, `alerts`
- `elements` - specific fields: `tempmax`, `tempmin`, `temp`, `precip`

### Response Structure
```json
{
  "queryCost": 1,
  "latitude": 40.7128,
  "longitude": -74.006,
  "resolvedAddress": "New York, NY",
  "timezone": "America/New_York",
  "days": [
    {
      "datetime": "2026-03-17",
      "tempmax": 52.0,
      "tempmin": 34.0,
      "temp": 43.0,
      "precip": 0.0,
      "precipprob": 10.0,
      "conditions": "Partially cloudy"
    }
  ]
}
```

### Example URLs
```
https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/New%20York%20City?unitGroup=us&key=YOUR_KEY&include=days&elements=tempmax,tempmin
https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/40.7128,-74.006?unitGroup=us&key=YOUR_KEY
https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/London,UK?unitGroup=us&key=YOUR_KEY
```

---

## City Coordinates & Station Reference

### Coordinates for API Calls

| City | Latitude | Longitude | IANA Timezone | WU Station |
|------|----------|-----------|---------------|------------|
| NYC (LaGuardia) | 40.7772 | -73.8726 | America/New_York | KLGA |
| London (City Airport) | 51.5053 | 0.0553 | Europe/London | EGLC |
| Seoul (Incheon) | 37.4602 | 126.4407 | Asia/Seoul | RKSI |
| LA (LAX) | 33.9425 | -118.4081 | America/Los_Angeles | KLAX |

### NWS Grid References (for NOAA API, US cities only)

To get grid references, call:
```
https://api.weather.gov/points/40.7772,-73.8726  (NYC)
https://api.weather.gov/points/33.9425,-118.4081  (LA)
```

Response provides the `gridId` (WFO office), `gridX`, `gridY` needed for forecast endpoints.

---

## Python Implementation Examples

### 1. Open-Meteo: Get Daily High/Low Forecast

```python
import requests
import pandas as pd

CITIES = {
    "NYC":    {"lat": 40.7772, "lon": -73.8726, "tz": "America/New_York"},
    "London": {"lat": 51.5053, "lon": 0.0553,   "tz": "Europe/London"},
    "Seoul":  {"lat": 37.4602, "lon": 126.4407, "tz": "Asia/Seoul"},
    "LA":     {"lat": 33.9425, "lon": -118.4081, "tz": "America/Los_Angeles"},
}

def get_daily_forecast(city_key, days=7, unit="fahrenheit"):
    """Fetch daily high/low temperature forecast from Open-Meteo."""
    city = CITIES[city_key]
    params = {
        "latitude": city["lat"],
        "longitude": city["lon"],
        "daily": "temperature_2m_max,temperature_2m_min",
        "temperature_unit": unit,
        "forecast_days": days,
        "timezone": city["tz"],
    }
    resp = requests.get("https://api.open-meteo.com/v1/forecast", params=params)
    resp.raise_for_status()
    data = resp.json()["daily"]
    df = pd.DataFrame(data)
    df["date"] = pd.to_datetime(df["time"])
    return df[["date", "temperature_2m_max", "temperature_2m_min"]]

# Example
nyc_forecast = get_daily_forecast("NYC", days=10)
print(nyc_forecast)
```

### 2. Open-Meteo: Get Hourly Forecast (find daily max yourself)

```python
def get_hourly_forecast(city_key, days=3, unit="fahrenheit"):
    """Fetch hourly temperature to compute our own daily max."""
    city = CITIES[city_key]
    params = {
        "latitude": city["lat"],
        "longitude": city["lon"],
        "hourly": "temperature_2m",
        "temperature_unit": unit,
        "forecast_days": days,
        "timezone": city["tz"],
    }
    resp = requests.get("https://api.open-meteo.com/v1/forecast", params=params)
    resp.raise_for_status()
    data = resp.json()["hourly"]
    df = pd.DataFrame(data)
    df["time"] = pd.to_datetime(df["time"])
    df["date"] = df["time"].dt.date

    # Compute daily max (mimics how WU finds highest temperature)
    daily_max = df.groupby("date")["temperature_2m"].max().reset_index()
    daily_max.columns = ["date", "max_temp"]
    return daily_max
```

### 3. Open-Meteo Ensemble: Probability of Temperature Brackets

```python
def get_bracket_probabilities(city_key, brackets, days=7, unit="fahrenheit"):
    """
    Get probability of temperature falling in each bracket.

    brackets: list of (low, high) tuples in the target unit.
              Use None for open-ended. E.g. [(None, 41), (42, 43), ..., (56, None)]
    """
    city = CITIES[city_key]

    # Build probability queries for each bracket
    hourly_vars = []
    for low, high in brackets:
        if low is None:
            # "X or below"
            hourly_vars.append(f"p~temperature_2m~lesseq~{high}")
        elif high is None:
            # "X or higher"
            hourly_vars.append(f"p~temperature_2m~moreeq~{low}")
        else:
            # Range bracket like "48-49"
            hourly_vars.append(f"p~temperature_2m~moreeq~{low}~lesseq~{high}")

    params = {
        "latitude": city["lat"],
        "longitude": city["lon"],
        "hourly": ",".join(hourly_vars),
        "models": "gfs_ensemble_025",
        "temperature_unit": unit,
        "forecast_days": days,
        "timezone": city["tz"],
    }
    resp = requests.get(
        "https://ensemble-api.open-meteo.com/v1/ensemble", params=params
    )
    resp.raise_for_status()
    return resp.json()


# NYC brackets matching Polymarket structure
nyc_brackets = [
    (None, 41),   # 41F or below
    (42, 43),
    (44, 45),
    (46, 47),
    (48, 49),
    (50, 51),
    (52, 53),
    (54, 55),
    (56, None),   # 56F or higher
]
probs = get_bracket_probabilities("NYC", nyc_brackets, days=3)
```

### 4. Open-Meteo Ensemble: Raw Member Data + Manual Probability

```python
def get_ensemble_members(city_key, days=7, unit="fahrenheit"):
    """Fetch all 31 GFS ensemble member temperature traces."""
    city = CITIES[city_key]
    params = {
        "latitude": city["lat"],
        "longitude": city["lon"],
        "hourly": "temperature_2m",
        "models": "gfs_ensemble_025",
        "temperature_unit": unit,
        "forecast_days": days,
        "timezone": city["tz"],
    }
    resp = requests.get(
        "https://ensemble-api.open-meteo.com/v1/ensemble", params=params
    )
    resp.raise_for_status()
    return resp.json()


def compute_daily_max_distribution(ensemble_json):
    """
    From raw ensemble hourly data, compute daily max temperature
    for each ensemble member, yielding a 31-member distribution
    of daily highs.
    """
    hourly = ensemble_json["hourly"]
    times = pd.to_datetime(hourly["time"])
    dates = times.date

    # Each member is temperature_2m_member0, temperature_2m_member1, etc.
    member_cols = [k for k in hourly.keys() if k.startswith("temperature_2m_member")]

    results = {}
    for col in member_cols:
        member_df = pd.DataFrame({"date": dates, "temp": hourly[col]})
        daily_max = member_df.groupby("date")["temp"].max()
        results[col] = daily_max

    distribution_df = pd.DataFrame(results)
    return distribution_df


def bracket_probability_from_ensemble(distribution_df, target_date, low, high):
    """
    Calculate probability of daily max falling in [low, high] bracket
    from ensemble member distribution.
    """
    if target_date not in distribution_df.index:
        raise ValueError(f"Date {target_date} not in forecast range")

    values = distribution_df.loc[target_date].values
    n_members = len(values)

    if low is None:
        count = sum(v <= high for v in values)
    elif high is None:
        count = sum(v >= low for v in values)
    else:
        count = sum(low <= v <= high for v in values)

    return count / n_members


# Usage
import datetime
ensemble_data = get_ensemble_members("NYC", days=5)
dist = compute_daily_max_distribution(ensemble_data)
target = datetime.date(2026, 3, 20)
prob = bracket_probability_from_ensemble(dist, target, 48, 49)
print(f"P(48-49F) on {target}: {prob:.1%}")
```

### 5. Open-Meteo Ensemble: Percentile Forecast

```python
def get_temperature_percentiles(city_key, percentiles=[10, 25, 50, 75, 90],
                                 days=7, unit="fahrenheit"):
    """Fetch temperature percentiles from ensemble distribution."""
    city = CITIES[city_key]
    hourly_vars = [f"q~temperature_2m~{p}" for p in percentiles]

    params = {
        "latitude": city["lat"],
        "longitude": city["lon"],
        "hourly": ",".join(hourly_vars),
        "models": "gfs_ensemble_025",
        "temperature_unit": unit,
        "forecast_days": days,
        "timezone": city["tz"],
    }
    resp = requests.get(
        "https://ensemble-api.open-meteo.com/v1/ensemble", params=params
    )
    resp.raise_for_status()
    return resp.json()
```

### 6. NOAA Weather API: NWS Point Forecast

```python
import requests

HEADERS = {"User-Agent": "(polymarket-weather-bot, user@example.com)"}

def get_nws_forecast(lat, lon):
    """Get NWS forecast for a US location (two-step process)."""
    # Step 1: Get grid reference
    points_url = f"https://api.weather.gov/points/{lat},{lon}"
    resp = requests.get(points_url, headers=HEADERS)
    resp.raise_for_status()
    metadata = resp.json()["properties"]

    grid_id = metadata["gridId"]
    grid_x = metadata["gridX"]
    grid_y = metadata["gridY"]

    # Step 2: Get raw gridpoint data
    grid_url = f"https://api.weather.gov/gridpoints/{grid_id}/{grid_x},{grid_y}"
    resp = requests.get(grid_url, headers=HEADERS, params={"units": "us"})
    resp.raise_for_status()
    props = resp.json()["properties"]

    return {
        "maxTemperature": props.get("maxTemperature", {}).get("values", []),
        "minTemperature": props.get("minTemperature", {}).get("values", []),
        "temperature": props.get("temperature", {}).get("values", []),
        "probabilityOfPrecipitation": props.get("probabilityOfPrecipitation", {}).get("values", []),
    }

# NYC (LaGuardia area)
nyc_forecast = get_nws_forecast(40.7772, -73.8726)
for entry in nyc_forecast["maxTemperature"][:5]:
    print(f"  {entry['validTime']}: {entry['value']}F")
```

### 7. NOAA: Human-Readable Forecast Periods

```python
def get_nws_periods(lat, lon):
    """Get human-readable 12-hour forecast periods."""
    points_url = f"https://api.weather.gov/points/{lat},{lon}"
    resp = requests.get(points_url, headers=HEADERS)
    resp.raise_for_status()
    forecast_url = resp.json()["properties"]["forecast"]

    resp = requests.get(forecast_url, headers=HEADERS, params={"units": "us"})
    resp.raise_for_status()
    periods = resp.json()["properties"]["periods"]

    for p in periods[:6]:
        print(f"{p['name']}: {p['temperature']}F - {p['shortForecast']}")

    return periods
```

### 8. Visual Crossing: Backup Forecast

```python
VC_API_KEY = "YOUR_VISUAL_CROSSING_KEY"  # Free signup at visualcrossing.com

def get_vc_forecast(location, unit_group="us"):
    """Get 15-day forecast from Visual Crossing."""
    base = "https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline"
    url = f"{base}/{location}"
    params = {
        "key": VC_API_KEY,
        "unitGroup": unit_group,
        "include": "days",
        "elements": "datetime,tempmax,tempmin,temp,precip,precipprob",
    }
    resp = requests.get(url, params=params)
    resp.raise_for_status()
    data = resp.json()

    df = pd.DataFrame(data["days"])
    return df[["datetime", "tempmax", "tempmin", "temp", "precip", "precipprob"]]

# Examples
nyc_vc = get_vc_forecast("New York City")
london_vc = get_vc_forecast("London,UK")
seoul_vc = get_vc_forecast("Seoul,South Korea", unit_group="metric")
```

### 9. Weather Underground: Scrape Resolution Data

```python
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from bs4 import BeautifulSoup
import time

def get_wu_daily_high(station_id, date_str):
    """
    Scrape Weather Underground history page for daily high temperature.
    date_str format: 'YYYY-M-D' (e.g., '2026-3-17')

    Station URL patterns:
      KLGA -> /history/daily/us/ny/new-york-city/KLGA/date/2026-3-17
      EGLC -> /history/daily/gb/london/EGLC/date/2026-3-17
      RKSI -> /history/daily/kr/incheon/RKSI/date/2026-3-17
      KLAX -> /history/daily/us/ca/los-angeles/KLAX/date/2026-3-17
    """
    STATION_PATHS = {
        "KLGA": "us/ny/new-york-city",
        "EGLC": "gb/london",
        "RKSI": "kr/incheon",
        "KLAX": "us/ca/los-angeles",
    }

    path = STATION_PATHS.get(station_id, "")
    url = f"https://www.wunderground.com/history/daily/{path}/{station_id}/date/{date_str}"

    options = Options()
    options.add_argument("--headless")
    driver = webdriver.Chrome(options=options)
    driver.get(url)
    time.sleep(5)  # Wait for JS rendering

    soup = BeautifulSoup(driver.page_source, "html.parser")
    driver.quit()

    # Parse the history table for max temperature
    # Structure varies; look for the daily summary table
    # The "Max" temperature row in the daily summary
    # This is fragile and may need updating if WU changes their HTML

    return soup  # Parse further based on current HTML structure
```

### 10. Using openmeteo-requests Library (Official SDK)

```python
# pip install openmeteo-requests requests-cache retry-requests

import openmeteo_requests
import requests_cache
from retry_requests import retry
import pandas as pd

# Setup client with caching
cache_session = requests_cache.CachedSession('.cache', expire_after=3600)
retry_session = retry(cache_session, retries=5, backoff_factor=0.2)
openmeteo = openmeteo_requests.Client(session=retry_session)

# Ensemble request
params = {
    "latitude": 40.7772,
    "longitude": -73.8726,
    "hourly": "temperature_2m",
    "models": "gfs_ensemble_025",
    "temperature_unit": "fahrenheit",
    "forecast_days": 7,
    "timezone": "America/New_York",
}

responses = openmeteo.weather_api(
    "https://ensemble-api.open-meteo.com/v1/ensemble", params=params
)
response = responses[0]

print(f"Coordinates: {response.Latitude()}N {response.Longitude()}E")
print(f"Elevation: {response.Elevation()} m asl")

# Extract hourly data
hourly = response.Hourly()
hourly_time = range(hourly.Time(), hourly.TimeEnd(), hourly.Interval())

# Build DataFrame with all ensemble members
hourly_data = {
    "date": pd.date_range(
        start=pd.to_datetime(hourly.Time(), unit="s"),
        end=pd.to_datetime(hourly.TimeEnd(), unit="s"),
        freq=pd.Timedelta(seconds=hourly.Interval()),
        inclusive="left"
    )
}

# Access individual ensemble members via Variables index
from openmeteo_sdk.Variable import Variable
hourly_variables = list(
    map(lambda i: hourly.Variables(i), range(0, hourly.VariablesLength()))
)

# Each variable has .Variable(), .Altitude(), and .EnsembleMember() attributes
for var in hourly_variables:
    member_id = var.EnsembleMember()
    hourly_data[f"member_{member_id}"] = var.ValuesAsNumpy()

df = pd.DataFrame(data=hourly_data)
print(df.head())
```

---

## Strategy Notes

### Forecast vs Resolution Source Mismatch
- Forecasts come from NWP models (GFS, ECMWF, etc.) via Open-Meteo or NOAA
- Resolution uses Weather Underground station observations
- WU hourly observations can differ from NWS official daily high
- Always compare your forecast against the specific WU station data format

### Recommended Data Pipeline
1. **Primary forecast**: Open-Meteo Ensemble API (GFS 31-member) for probability distributions
2. **Validation**: Cross-check with NOAA NWS forecast and Visual Crossing
3. **Resolution monitoring**: Watch Weather Underground history page for the target station
4. **Bracket mapping**: Convert ensemble distribution to Polymarket bracket probabilities

### Model Update Schedule
- GFS: Every 6 hours (00z, 06z, 12z, 18z)
- ECMWF: Every 6 hours
- HRRR: Every hour (US only, short-range)
- Best time to trade: Shortly after fresh model runs when you have newer data than the market

### Temperature Rounding
- Polymarket uses whole degrees (F or C depending on city)
- Your forecast models give decimal values
- Round to nearest whole degree to match resolution precision
- For bracket edge cases (e.g., forecast of 49.5F between 48-49F and 50-51F brackets), the ensemble spread is especially valuable
