#!/usr/bin/env node
/**
 * Polymarket BTC 5分钟市场数据收集脚本
 *
 * 每30秒采集一次: Binance BTC价格 + Polymarket UP/DOWN价格
 * 数据保存到 data/log.jsonl (JSON Lines 格式)
 *
 * 用法: node collect-data.mjs
 */

import { mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const GAMMA_HOST = "https://gamma-api.polymarket.com";
const BINANCE_BASE = "https://api.binance.com";
const MARKET_INTERVAL = 300;
const COLLECT_INTERVAL = 30_000; // 30 seconds
const DATA_DIR = join(__dirname, "data");
const LOG_FILE = join(DATA_DIR, "log.jsonl");

// Ensure data directory exists
mkdirSync(DATA_DIR, { recursive: true });

function getCurrentWindowTs() {
  const now = Math.floor(Date.now() / 1000);
  return now - (now % MARKET_INTERVAL);
}

function getNextWindowTs() {
  return getCurrentWindowTs() + MARKET_INTERVAL;
}

function getSecondsUntilClose() {
  const now = Math.floor(Date.now() / 1000);
  const windowEnd = getCurrentWindowTs() + MARKET_INTERVAL;
  return Math.max(0, windowEnd - now);
}

function getMarketSlug(windowTs) {
  return `btc-updown-5m-${windowTs}`;
}

async function fetchMarket(slug) {
  const url = `${GAMMA_HOST}/events?slug=${slug}`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (Array.isArray(data) && data.length > 0) return data[0];
  return null;
}

async function getCurrentMarket() {
  let market = await fetchMarket(getMarketSlug(getCurrentWindowTs()));
  if (market) return market;
  market = await fetchMarket(getMarketSlug(getNextWindowTs()));
  return market;
}

function parseMarketPrices(event) {
  const market = (event.markets || [])[0];
  if (!market) return null;

  let outcomes = market.outcomes;
  let outcomePrices = market.outcomePrices;
  if (typeof outcomes === "string") outcomes = JSON.parse(outcomes);
  if (typeof outcomePrices === "string") outcomePrices = JSON.parse(outcomePrices);

  const result = { upPrice: 0, downPrice: 0 };
  for (let i = 0; i < outcomes.length; i++) {
    const outcome = outcomes[i].toLowerCase();
    const price = parseFloat(outcomePrices[i]) || 0;
    if (outcome === "up") result.upPrice = price;
    else if (outcome === "down") result.downPrice = price;
  }
  return result;
}

async function fetchBtcPrice() {
  const url = `${BINANCE_BASE}/api/v3/ticker/price?symbol=BTCUSDT`;
  const resp = await fetch(url);
  const data = await resp.json();
  return parseFloat(data.price);
}

async function tick() {
  const [btcPrice, event] = await Promise.all([
    fetchBtcPrice(),
    getCurrentMarket(),
  ]);

  if (!event) {
    console.log(`[${new Date().toISOString()}] 未找到市场数据，跳过`);
    return;
  }

  const prices = parseMarketPrices(event);
  if (!prices) {
    console.log(`[${new Date().toISOString()}] 无法解析市场价格，跳过`);
    return;
  }

  const windowSlug = getMarketSlug(getCurrentWindowTs());
  const secondsUntilClose = getSecondsUntilClose();

  const record = {
    timestamp: new Date().toISOString(),
    binance_price: btcPrice,
    up_price: prices.upPrice,
    down_price: prices.downPrice,
    window_slug: windowSlug,
    seconds_until_close: secondsUntilClose,
  };

  appendFileSync(LOG_FILE, JSON.stringify(record) + "\n");
  console.log(
    `[${record.timestamp}] BTC=$${btcPrice.toFixed(2)} UP=$${prices.upPrice.toFixed(2)} DOWN=$${prices.downPrice.toFixed(2)} close_in=${secondsUntilClose}s`
  );
}

async function main() {
  console.log(`[数据收集] 每 ${COLLECT_INTERVAL / 1000} 秒采集一次`);
  console.log(`[数据收集] 输出文件: ${LOG_FILE}`);
  console.log("[数据收集] 按 Ctrl+C 停止\n");

  // Run immediately, then every 30s
  while (true) {
    try {
      await tick();
    } catch (e) {
      console.error(`[错误] ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, COLLECT_INTERVAL));
  }
}

main().catch(console.error);
