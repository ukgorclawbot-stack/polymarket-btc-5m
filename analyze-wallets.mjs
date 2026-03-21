#!/usr/bin/env node
/**
 * 分析 Polymarket BTC 5分钟市场的钱包胜率
 * 筛选条件:
 *   - 近两个月内活跃
 *   - 日均交易 > 100 笔
 *   - 按胜率排名 TOP 100
 *
 * 策略: 直接按时间戳生成所有 5m 市场 slug, 批量查询 Gamma API + Data API
 */

import fs from "fs";

const GAMMA_API = "https://gamma-api.polymarket.com";
const DATA_API = "https://data-api.polymarket.com";

const TWO_MONTHS_AGO = new Date(Date.now() - 60 * 86400 * 1000);
const NOW = new Date();
const INTERVAL = 300; // 5 minutes in seconds

// ── 工具函数 ──

async function fetchJSON(url, retries = 4) {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url);
      if (resp.status === 429) {
        const wait = Math.pow(2, i) * 3000;
        console.error(`  [429] 限流, 等${wait / 1000}s...`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Phase 1: 批量获取市场 conditionId + 结果 ──

async function collectMarkets() {
  console.log("=== Phase 1: 收集 BTC 5分钟市场 ===");

  const startTs = Math.floor(TWO_MONTHS_AGO.getTime() / 1000);
  const endTs = Math.floor(NOW.getTime() / 1000);
  // 对齐到 5 分钟边界
  const firstWindow = startTs - (startTs % INTERVAL);
  const lastWindow = endTs - (endTs % INTERVAL) - INTERVAL * 2; // 排除最近未结算的

  const totalWindows = Math.floor((lastWindow - firstWindow) / INTERVAL) + 1;
  console.log(`  时间范围: ${new Date(firstWindow * 1000).toISOString()} ~ ${new Date(lastWindow * 1000).toISOString()}`);
  console.log(`  理论窗口数: ${totalWindows}`);

  const markets = []; // { conditionId, slug, winner }
  let found = 0, notFound = 0, errors = 0;

  // 并发批量查询 Gamma API (每批 20 个并发)
  const CONCURRENCY = 20;
  const allTimestamps = [];
  for (let ts = firstWindow; ts <= lastWindow; ts += INTERVAL) {
    allTimestamps.push(ts);
  }

  for (let i = 0; i < allTimestamps.length; i += CONCURRENCY) {
    const batch = allTimestamps.slice(i, i + CONCURRENCY);
    const promises = batch.map(async (ts) => {
      const slug = `btc-updown-5m-${ts}`;
      try {
        const data = await fetchJSON(`${GAMMA_API}/markets?slug=${slug}`);
        if (!data || !data.length) { notFound++; return null; }
        const m = data[0];
        let winner = null;
        try {
          const prices = JSON.parse(m.outcomePrices || "[]");
          if (prices[0] === "1" || parseFloat(prices[0]) > 0.99) winner = "Up";
          else if (prices[1] === "1" || parseFloat(prices[1]) > 0.99) winner = "Down";
        } catch {}
        if (!winner) { notFound++; return null; }
        found++;
        return { conditionId: m.conditionId, slug, winner };
      } catch {
        errors++;
        return null;
      }
    });

    const results = await Promise.all(promises);
    for (const r of results) {
      if (r) markets.push(r);
    }

    if ((i + CONCURRENCY) % 500 === 0 || i + CONCURRENCY >= allTimestamps.length) {
      const pct = ((i + CONCURRENCY) / allTimestamps.length * 100).toFixed(0);
      console.log(`  进度: ${pct}% | 已找到: ${found} | 未找到: ${notFound} | 错误: ${errors}`);
    }
    await sleep(100);
  }

  console.log(`  总计: ${markets.length} 个已结算市场\n`);
  return markets;
}

// ── Phase 2: 批量获取交易数据 ──

async function collectTrades(markets) {
  console.log("=== Phase 2: 获取交易数据 ===");

  const winnerMap = new Map();
  for (const m of markets) {
    winnerMap.set(m.conditionId, m.winner);
  }

  const allTrades = [];
  const BATCH_SIZE = 10; // 每次查 10 个市场的交易
  let processed = 0;

  for (let i = 0; i < markets.length; i += BATCH_SIZE) {
    const batch = markets.slice(i, i + BATCH_SIZE);
    const conditionIds = batch.map(m => m.conditionId).join(",");

    let tradeOffset = 0;
    const tradeLimit = 2000;

    while (true) {
      let trades;
      try {
        trades = await fetchJSON(
          `${DATA_API}/trades?market=${conditionIds}&limit=${tradeLimit}&offset=${tradeOffset}`
        );
      } catch (e) {
        console.error(`  交易获取失败 batch=${i}: ${e.message}`);
        break;
      }

      if (!trades || !trades.length) break;

      for (const t of trades) {
        if (t.side !== "BUY") continue;
        const winner = winnerMap.get(t.conditionId);
        if (!winner) continue;

        allTrades.push({
          wallet: (t.proxyWallet || "").toLowerCase(),
          outcome: t.outcome,
          winner,
          size: parseFloat(t.size || "0"),
          price: parseFloat(t.price || "0"),
          timestamp: t.timestamp,
        });
      }

      if (trades.length < tradeLimit) break;
      tradeOffset += tradeLimit;
      await sleep(80);
    }

    processed += batch.length;
    if (processed % 100 === 0 || processed >= markets.length) {
      console.log(`  进度: ${processed}/${markets.length} 市场, ${allTrades.length} 笔买入交易`);
    }
    await sleep(100);
  }

  console.log(`  总计: ${allTrades.length} 笔买入交易\n`);
  return allTrades;
}

// ── Phase 3: 聚合钱包数据 ──

function aggregateWallets(trades) {
  console.log("=== Phase 3: 聚合钱包统计 ===");

  const wallets = new Map();

  for (const t of trades) {
    if (!t.wallet) continue;

    let w = wallets.get(t.wallet);
    if (!w) {
      w = { wins: 0, losses: 0, totalSize: 0, totalPnl: 0,
            firstSeen: t.timestamp, lastSeen: t.timestamp,
            tradeDays: new Set() };
      wallets.set(t.wallet, w);
    }

    const isWin = t.outcome === t.winner;
    if (isWin) {
      w.wins++;
      w.totalPnl += t.price > 0 ? (1 / t.price - 1) * t.size * t.price : 0;
    } else {
      w.losses++;
      w.totalPnl -= t.size;
    }
    w.totalSize += t.size;

    const day = new Date(t.timestamp).toISOString().split("T")[0];
    w.tradeDays.add(day);
    if (t.timestamp < w.firstSeen) w.firstSeen = t.timestamp;
    if (t.timestamp > w.lastSeen) w.lastSeen = t.timestamp;
  }

  console.log(`  唯一钱包: ${wallets.size}\n`);
  return wallets;
}

// ── Phase 4: 筛选和排名 ──

function filterAndRank(wallets) {
  console.log("=== Phase 4: 筛选 TOP 100 ===");

  const twoMonthsAgoTs = TWO_MONTHS_AGO.getTime();
  const results = [];

  for (const [addr, w] of wallets) {
    const totalTrades = w.wins + w.losses;
    const activeDays = w.tradeDays.size;
    const avgDailyTrades = activeDays > 0 ? totalTrades / activeDays : 0;
    const firstSeenTs = new Date(w.firstSeen).getTime();
    const winRate = totalTrades > 0 ? (w.wins / totalTrades * 100) : 0;

    // 筛选:
    // 1. 首次交易在近2个月内 (近期注册)
    if (firstSeenTs < twoMonthsAgoTs) continue;
    // 2. 日均交易 > 100 笔
    if (avgDailyTrades < 100) continue;
    // 3. 最少500笔 (防噪声)
    if (totalTrades < 500) continue;

    results.push({
      wallet: addr,
      winRate,
      wins: w.wins,
      losses: w.losses,
      totalTrades,
      avgDailyTrades: Math.round(avgDailyTrades),
      activeDays,
      totalPnl: Math.round(w.totalPnl * 100) / 100,
      totalSize: Math.round(w.totalSize * 100) / 100,
      firstSeen: new Date(w.firstSeen).toISOString().split("T")[0],
      lastSeen: new Date(w.lastSeen).toISOString().split("T")[0],
    });
  }

  results.sort((a, b) => b.winRate - a.winRate || b.totalTrades - a.totalTrades);
  const top100 = results.slice(0, 100);

  console.log(`  符合条件钱包: ${results.length}`);
  console.log(`  输出 TOP ${top100.length}\n`);
  return top100;
}

// ── 主入口 ──

async function main() {
  console.log(`\n=== Polymarket BTC 5分钟市场钱包胜率分析 ===`);
  console.log(`时间范围: ${TWO_MONTHS_AGO.toISOString().split("T")[0]} ~ ${NOW.toISOString().split("T")[0]}`);
  console.log(`筛选: 近2个月首次交易 + 日均交易>100笔 + 总交易>500笔\n`);

  const startTime = Date.now();

  const markets = await collectMarkets();
  if (!markets.length) { console.log("未找到市场, 退出"); return; }

  const trades = await collectTrades(markets);
  if (!trades.length) { console.log("未找到交易, 退出"); return; }

  const wallets = aggregateWallets(trades);
  const top100 = filterAndRank(wallets);

  // 输出
  console.log("=== TOP 100 钱包 (按胜率排名) ===\n");
  console.log("排名 | 钱包地址                                     | 胜率    | W/L          | 日均  | 天数 | PnL        | 首次交易");
  console.log("-----|----------------------------------------------|---------|--------------|-------|------|------------|----------");

  for (let i = 0; i < top100.length; i++) {
    const r = top100[i];
    const rank = String(i + 1).padStart(3);
    const wr = r.winRate.toFixed(1).padStart(5) + "%";
    const wl = `${r.wins}/${r.losses}`.padEnd(12);
    const daily = String(r.avgDailyTrades).padStart(5);
    const days = String(r.activeDays).padStart(4);
    const pnl = ("$" + r.totalPnl.toFixed(0)).padStart(10);
    console.log(` ${rank} | ${r.wallet} | ${wr} | ${wl} | ${daily} | ${days} | ${pnl} | ${r.firstSeen}`);
  }

  // 保存 JSON
  const outFile = "/Users/ukgorclawbot/Desktop/polymarket-btc-5m/top-wallets.json";
  fs.writeFileSync(outFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    criteria: {
      period: `${TWO_MONTHS_AGO.toISOString().split("T")[0]} to ${NOW.toISOString().split("T")[0]}`,
      minDailyTrades: 100,
      minTotalTrades: 500,
      registeredWithin: "2 months",
    },
    marketsAnalyzed: markets.length,
    totalTradesAnalyzed: trades.length,
    qualifiedWallets: top100.length,
    wallets: top100,
  }, null, 2));
  console.log(`\n结果已保存: ${outFile}`);

  const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`总耗时: ${elapsed} 分钟`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
