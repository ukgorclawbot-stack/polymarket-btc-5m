#!/usr/bin/env node
/**
 * Polymarket BTC 5分钟市场下单工具
 *
 * 用法:
 *   node index.mjs info                          # 查看当前市场信息
 *   node index.mjs buy up [金额]                 # 市价买 UP
 *   node index.mjs buy down [金额]               # 市价买 DOWN
 *   node index.mjs limit up <价格> <数量>         # 限价买 UP
 *   node index.mjs limit down <价格> <数量>       # 限价买 DOWN
 *   node index.mjs orders                        # 查看未成交订单
 *   node index.mjs cancel                        # 取消所有订单
 *   node index.mjs balance                       # 查看 USDC 余额和持仓
 *   node index.mjs auto up [金额]                # 自动模式: 每个窗口买 UP
 *   node index.mjs auto down [金额]              # 自动模式: 每个窗口买 DOWN
 *   node index.mjs book up                       # 查看 UP 的订单簿
 *   node index.mjs book down                     # 查看 DOWN 的订单簿
 */

import "dotenv/config";
import fs from "fs";
import { ClobClient, OrderType, Side, AssetType } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { JsonRpcProvider } from "@ethersproject/providers";
import { Contract } from "@ethersproject/contracts";

// ── PID 文件锁 (防止重复启动) ──
const PID_FILE = "/tmp/polymarket-scalp.pid";

function acquirePidLock() {
  try {
    if (fs.existsSync(PID_FILE)) {
      const oldPid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim());
      try {
        process.kill(oldPid, 0); // 测试进程是否存在
        console.error(`[错误] 已有运行中的实例 (PID ${oldPid}), 请先停止再启动`);
        process.exit(1);
      } catch {
        // 旧进程不存在, PID 文件是残留的
      }
    }
    fs.writeFileSync(PID_FILE, String(process.pid));
    process.on("exit", () => { try { fs.unlinkSync(PID_FILE); } catch {} });
    process.on("SIGINT", () => process.exit(0));
    process.on("SIGTERM", () => process.exit(0));
  } catch (e) {
    console.error(`[警告] PID锁获取失败: ${e.message}`);
  }
}

// ============ 配置 ============

const CLOB_HOST = "https://clob.polymarket.com";
const GAMMA_HOST = "https://gamma-api.polymarket.com";
const CHAIN_ID = 137;
const MARKET_INTERVAL = 300; // 5分钟

const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const FUNDER_ADDRESS = process.env.FUNDER_ADDRESS || "";
const SIGNATURE_TYPE = parseInt(process.env.SIGNATURE_TYPE || "0", 10);
const DEFAULT_BET_AMOUNT = parseFloat(process.env.BET_AMOUNT || "5");

// ============ 市场发现 ============

function getCurrentWindowTs() {
  const now = Math.floor(Date.now() / 1000);
  return now - (now % MARKET_INTERVAL);
}

function getNextWindowTs() {
  return getCurrentWindowTs() + MARKET_INTERVAL;
}

function getMarketSlug(windowTs) {
  return `btc-updown-5m-${windowTs}`;
}

function getSecondsUntilClose() {
  const now = Math.floor(Date.now() / 1000);
  const windowEnd = getCurrentWindowTs() + MARKET_INTERVAL;
  return Math.max(0, windowEnd - now);
}

async function fetchMarket(slug) {
  const url = `${GAMMA_HOST}/events?slug=${slug}`;
  try {
    const resp = await fetch(url);
    const data = await resp.json();
    if (Array.isArray(data) && data.length > 0) return data[0];
    return null;
  } catch (e) {
    console.error(`[错误] 获取市场数据失败: ${e.message}`);
    return null;
  }
}

async function getCurrentMarket() {
  // 尝试当前窗口
  let market = await fetchMarket(getMarketSlug(getCurrentWindowTs()));
  if (market) return market;
  // 尝试下一个窗口
  market = await fetchMarket(getMarketSlug(getNextWindowTs()));
  return market;
}

function parseMarketTokens(event) {
  const markets = event.markets || [];
  if (!markets.length) throw new Error("市场数据中没有 markets 字段");

  const market = markets[0];
  let outcomes = market.outcomes;
  let clobTokenIds = market.clobTokenIds;
  let outcomePrices = market.outcomePrices;

  if (typeof outcomes === "string") outcomes = JSON.parse(outcomes);
  if (typeof clobTokenIds === "string") clobTokenIds = JSON.parse(clobTokenIds);
  if (typeof outcomePrices === "string") outcomePrices = JSON.parse(outcomePrices);

  const result = {
    slug: event.slug || "",
    question: market.question || "",
    endDate: market.endDate || "",
    conditionId: market.conditionId || "",
    upTokenId: "",
    downTokenId: "",
    upPrice: 0,
    downPrice: 0,
    negRisk: market.negRisk ?? true,
  };

  for (let i = 0; i < outcomes.length; i++) {
    const outcome = outcomes[i].toLowerCase();
    const tokenId = clobTokenIds[i] || "";
    const price = parseFloat(outcomePrices[i]) || 0;
    if (outcome === "up") {
      result.upTokenId = tokenId;
      result.upPrice = price;
    } else if (outcome === "down") {
      result.downTokenId = tokenId;
      result.downPrice = price;
    }
  }

  return result;
}

function printMarketInfo(info) {
  const remaining = getSecondsUntilClose();
  console.log(`\n${"=".repeat(55)}`);
  console.log(`  市场: ${info.question}`);
  console.log(`  Slug: ${info.slug}`);
  console.log(`  结束时间: ${info.endDate}`);
  console.log(`  UP  价格: $${info.upPrice.toFixed(2)}  (token: ${info.upTokenId.slice(0, 16)}...)`);
  console.log(`  DOWN 价格: $${info.downPrice.toFixed(2)}  (token: ${info.downTokenId.slice(0, 16)}...)`);
  console.log(`  距离结束: ${remaining} 秒`);
  console.log(`${"=".repeat(55)}\n`);
}

// ============ 交易客户端 ============

let _client = null;

async function getClient() {
  if (_client) return _client;

  if (!PRIVATE_KEY) {
    throw new Error("请在 .env 文件中设置 PRIVATE_KEY");
  }

  const signer = new Wallet(PRIVATE_KEY);

  // 使用正确的签名类型和代理钱包创建客户端
  const tempClient = new ClobClient(CLOB_HOST, CHAIN_ID, signer, undefined, SIGNATURE_TYPE, FUNDER_ADDRESS || undefined);
  // 抑制 createOrDeriveApiKey 内部的 "Could not create api key" 错误日志
  const origError = console.error;
  console.error = () => {};
  const creds = await tempClient.createOrDeriveApiKey();
  console.error = origError;

  _client = new ClobClient(
    CLOB_HOST,
    CHAIN_ID,
    signer,
    creds,
    SIGNATURE_TYPE,
    FUNDER_ADDRESS || undefined,
  );

  return _client;
}

// ============ 命令实现 ============

async function cmdInfo() {
  const event = await getCurrentMarket();
  if (!event) {
    console.log("[错误] 未找到当前活跃的 BTC 5分钟市场");
    return;
  }
  const info = parseMarketTokens(event);
  printMarketInfo(info);
}

async function cmdBuy(side, amount) {
  amount = amount || DEFAULT_BET_AMOUNT;
  side = side.toUpperCase();

  const event = await getCurrentMarket();
  if (!event) {
    console.log("[错误] 未找到当前活跃的 BTC 5分钟市场");
    return;
  }

  const info = parseMarketTokens(event);
  printMarketInfo(info);

  const tokenId = side === "UP" ? info.upTokenId : info.downTokenId;
  const priceDisplay = side === "UP" ? info.upPrice : info.downPrice;

  if (!tokenId) {
    console.log(`[错误] 未找到 ${side} 的 token ID`);
    return;
  }

  const client = await getClient();

  // 下单前检查余额
  try {
    const collateral = await client.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });
    const rawBal = parseFloat(collateral.balance || "0");
    const balance = rawBal / 1e6;
    console.log(`[余额] USDC: $${balance.toFixed(2)}`);
    if (balance < amount) {
      console.log(`[错误] 余额不足: 需要 $${amount.toFixed(2)}, 当前 $${balance.toFixed(2)}`);
      return;
    }
  } catch (e) {
    console.log(`[警告] 余额检查失败 (${e.message}), 继续尝试下单...`);
  }

  console.log(`[下单] 方向=${side}, 金额=$${amount.toFixed(2)}, 当前价格=$${priceDisplay.toFixed(2)}`);

  try {
    const resp = await client.createAndPostMarketOrder(
      {
        tokenID: tokenId,
        amount,
        side: Side.BUY,
        price: 0.99, // 滑点保护
      },
      { negRisk: info.negRisk },
      OrderType.FOK,
    );

    console.log("[结果]", JSON.stringify(resp, null, 2));

    if (resp.success) {
      console.log(`[成功] 订单ID: ${resp.orderID || "N/A"}`);
      console.log(`[成功] 状态: ${resp.status || "N/A"}`);
    } else {
      console.log(`[失败] 错误: ${resp.errorMsg || "未知错误"}`);
    }
  } catch (e) {
    console.error(`[错误] 下单失败: ${e.message}`);
  }
}

async function cmdLimit(side, price, size) {
  side = side.toUpperCase();

  const event = await getCurrentMarket();
  if (!event) {
    console.log("[错误] 未找到当前活跃的 BTC 5分钟市场");
    return;
  }

  const info = parseMarketTokens(event);
  printMarketInfo(info);

  const tokenId = side === "UP" ? info.upTokenId : info.downTokenId;
  if (!tokenId) {
    console.log(`[错误] 未找到 ${side} 的 token ID`);
    return;
  }

  console.log(`[限价单] 方向=${side}, 价格=$${price.toFixed(2)}, 数量=${size}`);

  const client = await getClient();

  try {
    const resp = await client.createAndPostOrder(
      {
        tokenID: tokenId,
        price,
        size,
        side: Side.BUY,
      },
      { negRisk: info.negRisk },
      OrderType.GTC,
    );

    console.log("[结果]", JSON.stringify(resp, null, 2));
  } catch (e) {
    console.error(`[错误] 下单失败: ${e.message}`);
  }
}

async function cmdBook(side) {
  side = side.toUpperCase();

  const event = await getCurrentMarket();
  if (!event) {
    console.log("[错误] 未找到当前活跃的 BTC 5分钟市场");
    return;
  }

  const info = parseMarketTokens(event);
  const tokenId = side === "UP" ? info.upTokenId : info.downTokenId;

  if (!tokenId) {
    console.log(`[错误] 未找到 ${side} 的 token ID`);
    return;
  }

  const client = await getClient();
  const book = await client.getOrderBook(tokenId);

  console.log(`\n  ${side} 订单簿 (${info.slug})`);
  console.log(`  最后成交价: $${book.last_trade_price}`);
  console.log(`  Tick Size: ${book.tick_size}`);
  console.log(`  最小订单: ${book.min_order_size}`);
  console.log(`\n  --- 卖单 (Asks) ---`);
  (book.asks || []).slice(0, 10).reverse().forEach((a) => {
    console.log(`    $${a.price}  x  ${a.size}`);
  });
  console.log(`  --- 买单 (Bids) ---`);
  (book.bids || []).slice(0, 10).forEach((b) => {
    console.log(`    $${b.price}  x  ${b.size}`);
  });
  console.log();
}

async function cmdOrders() {
  const client = await getClient();
  const orders = await client.getOpenOrders();

  if (!orders || !orders.length) {
    console.log("[信息] 没有未成交订单");
    return;
  }

  console.log(`\n  未成交订单 (${orders.length}):`);
  for (const o of orders) {
    console.log(
      `  #${o.id?.slice(0, 12)}... ` +
      `side=${o.side} price=$${o.price} size=${o.original_size} ` +
      `status=${o.status} type=${o.order_type}`
    );
  }
  console.log();
}

async function cmdCancel() {
  const client = await getClient();
  const resp = await client.cancelAll();
  console.log("[结果]", JSON.stringify(resp, null, 2));
}

async function cmdBalance() {
  const client = await getClient();

  console.log(`\n${"=".repeat(55)}`);
  console.log(`  💰 Polymarket 账户余额`);

  // 查询 USDC (COLLATERAL) 余额和授权额度
  try {
    const collateral = await client.getBalanceAllowance({
      asset_type: AssetType.COLLATERAL,
    });
    const rawBalance = parseFloat(collateral.balance || "0");
    // USDC 有 6 位小数
    const balance = rawBalance / 1e6;
    console.log(`  USDC 余额: $${balance.toFixed(2)}`);

    // allowances 可能是对象 {contractAddress: "amount"} 或字符串
    if (collateral.allowances && typeof collateral.allowances === "object") {
      for (const [contract, amt] of Object.entries(collateral.allowances)) {
        const val = parseFloat(amt) / 1e6;
        if (val > 0) {
          console.log(`  授权额度 (${contract.slice(0, 10)}...): $${val.toFixed(2)}`);
        }
      }
    } else if (collateral.allowance) {
      const allowance = parseFloat(collateral.allowance) / 1e6;
      console.log(`  USDC 授权额度: $${allowance.toFixed(2)}`);
    }

    if (balance === 0) {
      console.log(`  ⚠️  余额为零，请先向代理钱包充值 USDC`);
    }
  } catch (e) {
    console.error(`  [错误] 获取 USDC 余额失败: ${e.message}`);
  }

  // 如果有当前市场，也查询条件代币余额
  try {
    const event = await getCurrentMarket();
    if (event) {
      const info = parseMarketTokens(event);
      if (info.upTokenId) {
        const upBal = await client.getBalanceAllowance({
          asset_type: AssetType.CONDITIONAL,
          token_id: info.upTokenId,
        });
        const upBalance = parseFloat(upBal.balance || "0");
        if (upBalance > 0) {
          console.log(`  UP 持仓: ${(upBalance / 1e6).toFixed(2)} 份`);
        }
      }
      if (info.downTokenId) {
        const downBal = await client.getBalanceAllowance({
          asset_type: AssetType.CONDITIONAL,
          token_id: info.downTokenId,
        });
        const downBalance = parseFloat(downBal.balance || "0");
        if (downBalance > 0) {
          console.log(`  DOWN 持仓: ${(downBalance / 1e6).toFixed(2)} 份`);
        }
      }
    }
  } catch (e) {
    // 条件代币余额获取失败不影响主流程
  }

  const signer = new Wallet(PRIVATE_KEY);
  console.log(`  钱包地址: ${signer.address}`);
  if (FUNDER_ADDRESS) {
    console.log(`  代理钱包: ${FUNDER_ADDRESS}`);
  }
  console.log(`${"=".repeat(55)}\n`);
}

async function cmdAuto(side, amount) {
  amount = amount || DEFAULT_BET_AMOUNT;
  side = side.toUpperCase();

  if (side !== "UP" && side !== "DOWN") {
    console.log(`[错误] 无效方向: ${side}, 请使用 UP 或 DOWN`);
    return;
  }

  console.log(`[自动模式] 方向=${side}, 每单金额=$${amount.toFixed(2)}`);
  console.log("[自动模式] 按 Ctrl+C 停止\n");

  let lastWindow = null;

  const loop = async () => {
    while (true) {
      try {
        const currentWindow = getCurrentWindowTs();
        const remaining = getSecondsUntilClose();

        // 在新窗口开始时下单 (窗口前15秒内)
        if (currentWindow !== lastWindow && remaining > MARKET_INTERVAL - 15) {
          console.log(`\n[自动] 新窗口: ${currentWindow} (${new Date(currentWindow * 1000).toISOString()})`);
          await cmdBuy(side, amount);
          lastWindow = currentWindow;
        }

        // 每5秒检查一次
        await new Promise((r) => setTimeout(r, 5000));
      } catch (e) {
        console.error(`[错误] ${e.message}`);
        await new Promise((r) => setTimeout(r, 10000));
      }
    }
  };

  await loop();
}

// ============ Binance 实时价格与策略 ============

const BINANCE_BASE = "https://api.binance.com";
const STRATEGY_CONFIDENCE = parseFloat(process.env.STRATEGY_CONFIDENCE || "0.05"); // 最小价格变化百分比
const LOW_VOL_THRESHOLD = parseFloat(process.env.LOW_VOL_THRESHOLD || "0.15");     // 低波动阈值 (%)
const OVERCONFIDENCE_THRESHOLD = parseFloat(process.env.OVERCONFIDENCE_THRESHOLD || "0.20"); // 过度自信阈值
const LAST_MINUTE_WINDOW = 60; // 最后1分钟窗口 (秒)

// 获取 BTC 当前价格
async function fetchBtcPrice() {
  const url = `${BINANCE_BASE}/api/v3/ticker/price?symbol=BTCUSDT`;
  const resp = await fetch(url);
  const data = await resp.json();
  return parseFloat(data.price);
}

// 获取最近 N 根 5分钟 K 线
async function fetchBtcKlines(limit = 6) {
  const url = `${BINANCE_BASE}/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=${limit}`;
  const resp = await fetch(url);
  const raw = await resp.json();
  return raw.map((k) => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    closeTime: k[6],
  }));
}

// 分析趋势，返回 { side, confidence, details }
async function analyzeTrend() {
  const currentPrice = await fetchBtcPrice();
  const klines = await fetchBtcKlines(6);

  if (klines.length < 2) {
    console.log("[策略] K线数据不足，默认不交易");
    return { side: null, confidence: 0, currentPrice, details: "K线数据不足" };
  }

  const latest = klines[klines.length - 1];
  const previous = klines[klines.length - 2];
  const oldest = klines[0];

  // 指标1: 最近一根 K 线的涨跌
  const latestChange = ((latest.close - latest.open) / latest.open) * 100;

  // 指标2: 当前价格相对 5 分钟前的变化
  const price5mAgo = oldest.open;
  const change5m = ((currentPrice - price5mAgo) / price5mAgo) * 100;

  // 指标3: 5 分钟内的最高最低点相对位置
  const allHighs = klines.map((k) => k.high);
  const allLows = klines.map((k) => k.low);
  const periodHigh = Math.max(...allHighs);
  const periodLow = Math.min(...allLows);
  const positionInRange = (currentPrice - periodLow) / (periodHigh - periodLow || 1);

  // 指标4: 简单成交量趋势 (最近3根 vs 之前3根)
  const recent3Vol = klines.slice(-3).reduce((s, k) => s + k.volume, 0);
  const prev3Vol = klines.slice(0, 3).reduce((s, k) => s + k.volume, 0);
  const volTrend = recent3Vol > prev3Vol ? 1 : -1;

  // 综合评分 (-100 ~ +100)
  let score = 0;
  score += latestChange > 0 ? 20 : -20;  // 最新K线涨跌
  score += change5m * 10;                  // 5分钟变化（放大）
  score += (positionInRange - 0.5) * 40;  // 在区间位置
  score += volTrend * 10;                  // 成交量趋势

  // 决策
  const secondsLeft = getSecondsUntilClose();
  const isLastMinute = secondsLeft < LAST_MINUTE_WINDOW;
  const isLowVol = Math.abs(change5m) < LOW_VOL_THRESHOLD;

  let side;
  let confidence = Math.abs(change5m);
  let mode; // "reversal" | "trend" | "skip"

  if (isLowVol) {
    if (isLastMinute) {
      // 低波动 + 最后1分钟 → 反转模式
      // 数据验证: 最后1分钟下跌→反转UP胜率69.4%，上涨→反转DOWN胜率50%
      // 只在最后1分钟下跌时反转，上涨时跳过
      if (change5m < -0.01) {
        mode = "reversal";
        side = "UP"; // 押反转上涨 (69.4% 胜率)
      } else if (change5m > 0.01) {
        mode = "skip";
        side = null; // 上涨反转信号弱，跳过
      } else {
        mode = "reversal";
        side = score > 0 ? "UP" : "DOWN"; // 变化极小时用趋势评分
      }
    } else {
      // 低波动但不在最后1分钟 → 信号太弱，跳过
      mode = "skip";
      side = null;
    }
  } else {
    // 正常波动 → 趋势模式: 跟随综合评分
    mode = "trend";
    side = score > 0 ? "UP" : "DOWN";
  }

  const details = {
    currentPrice: currentPrice.toFixed(2),
    latestChange: latestChange.toFixed(3) + "%",
    change5m: change5m.toFixed(3) + "%",
    positionInRange: positionInRange.toFixed(2),
    volTrend: volTrend > 0 ? "放量" : "缩量",
    score: score.toFixed(1),
    mode,
    isLastMinute,
    isLowVol,
    secondsLeft,
  };

  return { side, confidence, currentPrice, details };
}

// 打印策略分析结果
function printStrategy(analysis) {
  const d = analysis.details;
  const modeLabel = d.mode === "reversal" ? "反转模式" : d.mode === "skip" ? "跳过 (低波动)" : "趋势模式";
  const volLabel = d.isLowVol ? "低波动" : "正常波动";
  const lastMinLabel = d.isLastMinute ? `是 (${d.secondsLeft}s)` : `否 (${d.secondsLeft}s)`;

  console.log(`\n${"=".repeat(55)}`);
  console.log(`  🔍 Binance BTC 策略分析`);
  console.log(`  当前价格: $${d.currentPrice}`);
  console.log(`  最新K线涨跌: ${d.latestChange}`);
  console.log(`  5分钟变化: ${d.change5m}`);
  console.log(`  区间位置: ${d.positionInRange} (0=底部, 1=顶部)`);
  console.log(`  成交量趋势: ${d.volTrend}`);
  console.log(`  综合评分: ${d.score}`);
  console.log(`  波动状态: ${volLabel} (阈值: ${LOW_VOL_THRESHOLD}%)`);
  console.log(`  最后一分钟: ${lastMinLabel}`);
  console.log(`  策略模式: ${modeLabel}`);
  if (analysis.side) {
    console.log(`  ➡️  建议方向: ${analysis.side} (置信度: ${analysis.confidence.toFixed(3)}%)`);
  } else {
    console.log(`  ➡️  建议: 跳过 (波动不足，未到最后一分钟)`);
  }
  console.log(`${"=".repeat(55)}\n`);
}

// 过度自信反转检测: 在趋势分析之前检查市场价格
function checkOverconfidence(info, change5m) {
  const isFalling = change5m < 0;
  const isRising = change5m > 0;

  if (isFalling && info.downPrice > OVERCONFIDENCE_THRESHOLD) {
    return { triggered: true, side: "UP", reason: `价格下跌 + DOWN价格 $${info.downPrice.toFixed(2)} > $${OVERCONFIDENCE_THRESHOLD} → 反转买UP` };
  }
  if (isRising && info.upPrice > OVERCONFIDENCE_THRESHOLD) {
    return { triggered: true, side: "DOWN", reason: `价格上涨 + UP价格 $${info.upPrice.toFixed(2)} > $${OVERCONFIDENCE_THRESHOLD} → 反转买DOWN` };
  }
  return { triggered: false };
}

// 单次策略执行
async function cmdStrategy(amount) {
  amount = amount || DEFAULT_BET_AMOUNT;

  console.log("[策略] 开始分析 Binance BTC 价格趋势...");

  // 获取市场数据用于过度自信检测
  const event = await getCurrentMarket();
  if (!event) {
    console.log("[错误] 未找到当前活跃的 BTC 5分钟市场");
    return;
  }
  const info = parseMarketTokens(event);

  // 获取当前价格变化用于方向判断
  const currentPrice = await fetchBtcPrice();
  const klines = await fetchBtcKlines(6);
  const price5mAgo = klines.length > 0 ? klines[0].open : currentPrice;
  const change5m = ((currentPrice - price5mAgo) / price5mAgo) * 100;

  // 先检查过度自信反转
  const overconf = checkOverconfidence(info, change5m);
  if (overconf.triggered) {
    console.log(`\n[过度自信反转] ${overconf.reason}`);
    console.log(`[过度自信反转] UP价格=$${info.upPrice.toFixed(2)}, DOWN价格=$${info.downPrice.toFixed(2)}, 阈值=$${OVERCONFIDENCE_THRESHOLD}`);
    console.log(`[过度自信反转] 5分钟变化: ${change5m.toFixed(3)}%`);
    printMarketInfo(info);
    console.log(`[策略] 过度自信反转选择方向: ${overconf.side}`);
    await cmdBuy(overconf.side, amount);
    return;
  }

  // 正常趋势/反转分析
  const analysis = await analyzeTrend();
  printStrategy(analysis);

  if (!analysis.side) {
    console.log("[策略] 无法确定方向，跳过下单");
    return;
  }

  if (analysis.confidence < STRATEGY_CONFIDENCE) {
    console.log(`[策略] 置信度 ${analysis.confidence.toFixed(3)}% < 阈值 ${STRATEGY_CONFIDENCE}%，跳过下单`);
    return;
  }

  console.log(`[策略] 根据分析自动选择方向: ${analysis.side}`);
  await cmdBuy(analysis.side, amount);
}

// ============ 自动 Redeem 获胜仓位 ============

const POLYGON_RPC = "https://polygon-bor-rpc.publicnode.com";
const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const MULTISEND_ADDR = "0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761";
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

// ── Redeem 全局状态 ──
let _redeemRunning = false;
let _redeemFailedWindows = new Set(); // 失败过的窗口, 下次优先重试

async function cmdRedeem() {
  // 防止并发 Redeem (nonce 冲突根源)
  if (_redeemRunning) {
    console.log("[Redeem] 跳过: 上一次 Redeem 仍在执行");
    return;
  }
  _redeemRunning = true;
  try {
    await _doRedeem();
  } finally {
    _redeemRunning = false;
  }
}

async function _doRedeem() {
  if (!FUNDER_ADDRESS || SIGNATURE_TYPE !== 2) {
    console.log("[Redeem] 需要 FUNDER_ADDRESS 和 SIGNATURE_TYPE=2 (Gnosis Safe)");
    return;
  }

  const provider = new JsonRpcProvider(POLYGON_RPC);
  const signer = new Wallet(PRIVATE_KEY, provider);
  const safeAddress = FUNDER_ADDRESS;

  const ctf = new Contract(CTF_ADDRESS, [
    "function balanceOf(address, uint256) view returns (uint256)",
    "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
    "function payoutNumerators(bytes32, uint256) view returns (uint256)",
  ], provider);

  const now = Math.floor(Date.now() / 1000);
  const redeemTxs = [];

  // 扫描最近 2~30 个窗口 (覆盖2.5小时), 加上之前失败的窗口
  const windowsToCheck = new Set();
  for (let i = 2; i <= 30; i++) {
    windowsToCheck.add(now - (now % MARKET_INTERVAL) - (i * MARKET_INTERVAL));
  }
  for (const w of _redeemFailedWindows) {
    windowsToCheck.add(w);
  }
  // 清除太老的失败记录 (>6小时)
  const cutoff = now - 6 * 3600;
  for (const w of _redeemFailedWindows) {
    if (w < cutoff) _redeemFailedWindows.delete(w);
  }

  // 并行批量查询市场 (每批5个)
  const windowArr = [...windowsToCheck].sort((a, b) => b - a);
  for (let batch = 0; batch < windowArr.length; batch += 5) {
    const batchWindows = windowArr.slice(batch, batch + 5);
    const results = await Promise.all(batchWindows.map(async (windowTs) => {
      const slug = getMarketSlug(windowTs);
      const event = await fetchMarket(slug);
      if (!event) return null;

      const market = (event.markets || [])[0];
      if (!market?.conditionId) return null;

      const info = parseMarketTokens(event);

      let upBal, downBal;
      try {
        upBal = info.upTokenId ? await ctf.balanceOf(safeAddress, info.upTokenId) : 0;
        downBal = info.downTokenId ? await ctf.balanceOf(safeAddress, info.downTokenId) : 0;
      } catch {
        return null;
      }

      const upZero = typeof upBal === "object" ? upBal.isZero() : upBal === 0;
      const downZero = typeof downBal === "object" ? downBal.isZero() : downBal === 0;
      if (upZero && downZero) {
        // 没有余额, 说明已赎回, 从失败列表移除
        _redeemFailedWindows.delete(windowTs);
        return null;
      }

      let winner = "unknown";
      try {
        const p0 = await ctf.payoutNumerators(market.conditionId, 0);
        const p1 = await ctf.payoutNumerators(market.conditionId, 1);
        const p0Pos = typeof p0 === "object" ? !p0.isZero() : p0 > 0;
        const p1Pos = typeof p1 === "object" ? !p1.isZero() : p1 > 0;
        winner = p0Pos ? "UP" : p1Pos ? "DOWN" : "unresolved";
      } catch {}

      if (winner === "unresolved") return null; // 未结算, 跳过

      console.log(`[Redeem] ${slug}: UP=${upBal.toString()}, DOWN=${downBal.toString()}, winner=${winner}`);

      const data = ctf.interface.encodeFunctionData("redeemPositions", [
        USDC_ADDRESS, ZERO_BYTES32, market.conditionId, [1, 2],
      ]);
      return { to: CTF_ADDRESS, data, windowTs };
    }));

    for (const r of results) {
      if (r) redeemTxs.push(r);
    }
  }

  if (redeemTxs.length === 0) {
    return; // 静默, 不打印噪音
  }

  // 分批提交 (每批最多4个, 减少单笔gas消耗和失败风险)
  const BATCH_SIZE = 4;
  for (let i = 0; i < redeemTxs.length; i += BATCH_SIZE) {
    const chunk = redeemTxs.slice(i, i + BATCH_SIZE);
    const success = await _submitRedeemBatch(signer, safeAddress, provider, chunk);
    if (!success) {
      for (const tx of chunk) {
        _redeemFailedWindows.add(tx.windowTs);
      }
    } else {
      for (const tx of chunk) {
        _redeemFailedWindows.delete(tx.windowTs);
      }
    }
    // 批次间等待足够久, 确保 nonce 和 mempool 完全更新
    if (i + BATCH_SIZE < redeemTxs.length) await sleep(8000);
  }
}

async function _submitRedeemBatch(signer, safeAddress, provider, redeemTxs) {
  const safeContract = new Contract(safeAddress, [
    "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes signatures) payable returns (bool)",
    "function nonce() view returns (uint256)",
    "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)",
  ], signer);

  let targetTo, targetData, operation;

  if (redeemTxs.length === 1) {
    targetTo = redeemTxs[0].to;
    targetData = redeemTxs[0].data;
    operation = 0;
  } else {
    let packedHex = "";
    for (const tx of redeemTxs) {
      const dataNoPrefix = tx.data.slice(2);
      const dataLen = dataNoPrefix.length / 2;
      packedHex += "00";
      packedHex += tx.to.slice(2).toLowerCase().padStart(40, "0");
      packedHex += "0".repeat(64);
      packedHex += dataLen.toString(16).padStart(64, "0");
      packedHex += dataNoPrefix;
    }
    const multiSend = new Contract(MULTISEND_ADDR, [
      "function multiSend(bytes)",
    ], provider);
    targetTo = MULTISEND_ADDR;
    targetData = multiSend.interface.encodeFunctionData("multiSend", ["0x" + packedHex]);
    operation = 1;
  }

  // 重试提交最多4次 (递增gas价格, 等待 pending TX)
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      // 等待所有 pending TX 完成后再获取 nonce (避免 replacement 冲突)
      if (attempt > 0) {
        const pendingCount = await provider.getTransactionCount(signer.address, "pending");
        const confirmedCount = await provider.getTransactionCount(signer.address, "latest");
        if (pendingCount > confirmedCount) {
          console.log(`[Redeem] 等待 ${pendingCount - confirmedCount} 笔pending TX确认...`);
          await sleep(8000);
        }
      }

      const nonce = await safeContract.nonce();
      const txHash = await safeContract.getTransactionHash(
        targetTo, 0, targetData, operation, 0, 0, 0, ZERO_ADDR, ZERO_ADDR, nonce
      );

      const sig = await signer.signMessage(Buffer.from(txHash.slice(2), "hex"));
      const sigBytes = Buffer.from(sig.slice(2), "hex");
      sigBytes[64] += 4;
      const signature = "0x" + sigBytes.toString("hex");

      // 高 gas 起步 + 递增 (Polygon 经常需要 50+ gwei)
      const priorityFee = 50000000000n * BigInt(attempt + 1);  // 50/100/150/200 gwei
      const maxFee = 300000000000n + priorityFee;               // 350/400/450/500 gwei max

      console.log(`[Redeem] 提交 Safe 交易 (${redeemTxs.length} 个市场)${attempt > 0 ? ` 重试${attempt+1}` : ""}...`);
      const tx = await safeContract.execTransaction(
        targetTo, 0, targetData, operation, 0, 0, 0, ZERO_ADDR, ZERO_ADDR, signature,
        { gasLimit: 400000 + redeemTxs.length * 120000, maxPriorityFeePerGas: priorityFee, maxFeePerGas: maxFee }
      );
      console.log(`[Redeem] TX: ${tx.hash}`);
      // 带超时的等待 (最多60秒, 防止 tx.wait() 永久阻塞)
      const receipt = await Promise.race([
        tx.wait(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("TX确认超时60s")), 60000)),
      ]);
      if (receipt.status === 1) {
        console.log(`[Redeem] 成功赎回 ${redeemTxs.length} 个市场的仓位`);
        return true;
      }
      console.log("[Redeem] 交易reverted (status=0), 可能已被其他TX赎回");
      return false; // on-chain revert = data问题, 不再重试相同数据
    } catch (e) {
      const msg = (e.reason || e.message || "").slice(0, 80);
      console.log(`[Redeem] 执行失败: ${msg}`);
      // nonce/gas/超时 相关错误 → 重试
      if (msg.includes("replacement") || msg.includes("nonce") || msg.includes("replaced") || msg.includes("transaction failed") || msg.includes("underpriced") || msg.includes("超时")) {
        await sleep(6000 * (attempt + 1));
        continue;
      }
      // 其他错误直接放弃本批
      break;
    }
  }
  return false;
}

// 连续自动策略模式
async function cmdStrategyAuto(amount) {
  amount = amount || DEFAULT_BET_AMOUNT;

  console.log(`[自动策略] 每单金额=$${amount.toFixed(2)}, 置信度阈值=${STRATEGY_CONFIDENCE}%`);
  console.log("[自动策略] 按 Ctrl+C 停止\n");

  let lastWindow = null;

  while (true) {
    try {
      const currentWindow = getCurrentWindowTs();
      const remaining = getSecondsUntilClose();

      // 在新窗口开始时自动领取上一轮奖励
      if (currentWindow !== lastWindow && remaining > MARKET_INTERVAL - 15) {
        // 先尝试领取获胜仓位
        try { await cmdRedeem(); } catch(e) { console.log(`[Redeem] 跳过: ${e.message?.slice(0, 50)}`); }
        
        console.log(`\n[自动策略] 新窗口: ${currentWindow} (${new Date(currentWindow * 1000).toISOString()})`);

        // 先检查过度自信反转
        const event = await getCurrentMarket();
        if (event) {
          const info = parseMarketTokens(event);
          const currentPrice = await fetchBtcPrice();
          const klines = await fetchBtcKlines(6);
          const price5mAgo = klines.length > 0 ? klines[0].open : currentPrice;
          const change5m = ((currentPrice - price5mAgo) / price5mAgo) * 100;

          const overconf = checkOverconfidence(info, change5m);
          if (overconf.triggered) {
            console.log(`[过度自信反转] ${overconf.reason}`);
            await cmdBuy(overconf.side, amount);
            lastWindow = currentWindow;
            await new Promise((r) => setTimeout(r, 5000));
            continue;
          }
        }

        const analysis = await analyzeTrend();
        printStrategy(analysis);

        if (analysis.side && analysis.confidence >= STRATEGY_CONFIDENCE) {
          console.log(`[自动策略] 选择 ${analysis.side}，下单中...`);
          await cmdBuy(analysis.side, amount);
        } else {
          console.log("[自动策略] 条件不满足，本轮跳过");
        }

        lastWindow = currentWindow;
      }

      // 每5秒检查一次
      await new Promise((r) => setTimeout(r, 5000));
    } catch (e) {
      console.error(`[错误] ${e.message}`);
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
}

// ============ 刷单策略 (Scalping) ============

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function cmdScalp(betAmount) {
  acquirePidLock(); // 防止重复启动
  betAmount = betAmount || parseFloat(process.env.SCALP_AMOUNT || "1");

  // 策略参数 (可通过环境变量覆盖)
  const TP = parseFloat(process.env.SCALP_TP || "0.03");          // 止盈: token涨3分
  const SL = parseFloat(process.env.SCALP_SL || "0.05");          // 止损: token跌5分
  const BTC_TRIGGER = parseFloat(process.env.SCALP_TRIGGER || "0.015"); // BTC变动触发 (%)
  const LOOKBACK_MS = 15000;                                       // BTC回看15秒
  const POLL_MS = 2000;                                            // 轮询间隔2秒
  const EXIT_BEFORE_S = 45;                                        // 结束前45秒平仓
  const MIN_HOLD_S = 90;                                           // 最少持仓90秒 (等链上结算)
  const MAX_TRADES = parseInt(process.env.SCALP_MAX_TRADES || "5");
  const COOLDOWN_MS = 10000;                                       // 交易间冷却10秒
  const MIN_BALANCE = betAmount * 2;                                // 最低余额: 2倍单笔

  console.log(`[刷单] 参数: 单笔=$${betAmount} 止盈=${(TP*100).toFixed(0)}¢ 止损=${(SL*100).toFixed(0)}¢ BTC阈值=${BTC_TRIGGER}%`);
  console.log(`[刷单] 每窗口最多${MAX_TRADES}笔, 冷却${COOLDOWN_MS/1000}s, ${EXIT_BEFORE_S}s前清仓`);
  console.log(`[刷单] 最低余额=$${MIN_BALANCE} | 按 Ctrl+C 停止\n`);

  const client = await getClient();
  let lastWindow = null;
  let position = null;  // {side, tokenId, entryPrice, tokens, cost, negRisk}
  let windowTrades = 0;
  let lastTradeMs = 0;
  const stats = { wins: 0, losses: 0, pnl: 0 };
  const btcBuf = [];    // [{ts, price}]
  let lastStatusLog = 0;
  let lastBalanceCheck = 0;
  let cachedBalance = null;
  let consecutiveRedeemWindows = 0; // 连续多少个窗口触发了redeem
  let lowBalanceWarned = false;

  while (true) {
    try {
      const win = getCurrentWindowTs();
      const remaining = getSecondsUntilClose();

      // ── 新窗口 ──
      if (win !== lastWindow) {
        if (position) {
          await scalpExit(client, position, stats, "窗口结束");
          position = null;
        }

        lastWindow = win;
        windowTrades = 0;
        btcBuf.length = 0;
        lowBalanceWarned = false;
        console.log(`\n[刷单] ═══ 窗口 ${win} (${new Date(win * 1000).toISOString()}) ═══`);
        console.log(`[刷单] 累计: ${stats.wins + stats.losses}笔 W${stats.wins}/L${stats.losses} PnL=$${stats.pnl.toFixed(2)}`);

        // 异步redeem，不阻塞主循环
        cmdRedeem().catch(e => console.log(`[刷单] Redeem错误: ${(e.message||"").slice(0,60)}`));
      }

      // ── 定期检查余额 (每60秒) ──
      const now = Date.now();
      if (now - lastBalanceCheck > 60000) {
        try {
          const collateral = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
          cachedBalance = parseFloat(collateral.balance || "0") / 1e6;
          lastBalanceCheck = now;
        } catch {}
      }

      // ── 余额不足: 触发紧急Redeem ──
      if (cachedBalance !== null && cachedBalance < MIN_BALANCE && !position) {
        if (!lowBalanceWarned) {
          console.log(`[刷单] ⚠️ 余额不足 $${cachedBalance.toFixed(2)} < $${MIN_BALANCE}, 等待Redeem回款...`);
          lowBalanceWarned = true;
          // 立即触发一次Redeem (如果没有在跑)
          cmdRedeem().catch(e => {});
        }
        await sleep(POLL_MS * 2);
        lastBalanceCheck = 0; // 强制下次重新检查余额
        continue;
      }

      // ── 获取实时数据 ──
      const [btcPrice, event] = await Promise.all([fetchBtcPrice(), getCurrentMarket()]);
      if (!event) { await sleep(POLL_MS); continue; }
      const info = parseMarketTokens(event);

      // BTC价格追踪
      btcBuf.push({ ts: now, price: btcPrice });
      while (btcBuf.length > 0 && now - btcBuf[0].ts > 60000) btcBuf.shift();

      // ── 临近结束: 强制平仓 ──
      if (remaining < EXIT_BEFORE_S) {
        if (position) {
          await scalpExit(client, position, stats, "临近结束");
          position = null;
        }
        await sleep(POLL_MS);
        continue;
      }

      // ── 有持仓: 监控止盈/止损 ──
      if (position) {
        const curPrice = position.side === "UP" ? info.upPrice : info.downPrice;
        const diff = curPrice - position.entryPrice;
        const holdSec = (now - position.entryTime) / 1000;

        // 必须持仓至少 MIN_HOLD_S 秒, 等链上结算完成
        if (holdSec >= MIN_HOLD_S) {
          if (diff >= TP) {
            await scalpExit(client, position, stats, `止盈 +${(diff * 100).toFixed(0)}¢ (持${holdSec.toFixed(0)}s)`);
            position = null;
            lastTradeMs = now;
          } else if (diff <= -SL) {
            await scalpExit(client, position, stats, `止损 ${(diff * 100).toFixed(0)}¢ (持${holdSec.toFixed(0)}s)`);
            position = null;
            lastTradeMs = now;
          }
        }
      }

      // ── 无持仓: 寻找入场信号 (需至少 MIN_HOLD_S+EXIT_BEFORE_S 秒) ──
      if (!position && windowTrades < MAX_TRADES && remaining > MIN_HOLD_S + EXIT_BEFORE_S && now - lastTradeMs > COOLDOWN_MS) {
        const oldest = btcBuf.find(p => p.ts >= now - LOOKBACK_MS);
        if (oldest && btcBuf.length >= 5) {
          const btcChg = ((btcPrice - oldest.price) / oldest.price) * 100;

          // 每30秒输出状态
          if (now - lastStatusLog > 30000) {
            console.log(`[刷单] BTC=$${btcPrice.toFixed(0)} 15s变动=${btcChg > 0 ? "+" : ""}${btcChg.toFixed(4)}% UP=$${info.upPrice.toFixed(2)} DOWN=$${info.downPrice.toFixed(2)} 剩余${remaining}s`);
            lastStatusLog = now;
          }

          let side = null;
          if (btcChg > BTC_TRIGGER) side = "UP";
          else if (btcChg < -BTC_TRIGGER) side = "DOWN";

          if (side) {
            position = await scalpEnter(client, side, betAmount, info);
            if (position) {
              windowTrades++;
              lastTradeMs = now;
              lastBalanceCheck = 0; // 交易后立即重新检查余额
              console.log(`[刷单] 开仓 ${side} $${position.cost.toFixed(2)} → ${position.tokens.toFixed(3)} tokens @$${position.entryPrice.toFixed(3)} (BTC ${btcChg > 0 ? "+" : ""}${btcChg.toFixed(3)}%)`);
            }
          }
        }
      }

      await sleep(POLL_MS);
    } catch (e) {
      console.error(`[刷单] 错误: ${(e.message || "").slice(0, 80)}`);
      await sleep(5000);
    }
  }
}

async function scalpEnter(client, side, amount, info) {
  const tokenId = side === "UP" ? info.upTokenId : info.downTokenId;
  const entryPrice = side === "UP" ? info.upPrice : info.downPrice;

  // 限价买入, 最多高于当前价 15¢ (防止过度滑点)
  const maxPrice = Math.min(entryPrice + 0.15, 0.95);
  try {
    const resp = await client.createAndPostMarketOrder(
      { tokenID: tokenId, amount, side: Side.BUY, price: maxPrice },
      { negRisk: info.negRisk },
      OrderType.FOK,
    );

    if (resp.success) {
      let tokens = parseFloat(resp.takingAmount || "0");
      let cost = parseFloat(resp.makingAmount || amount.toString());
      // CLOB 返回的是微单位 (1e6), 需要转换
      if (tokens > 1000) tokens = tokens / 1e6;
      if (cost > 1000) cost = cost / 1e6;

      // 等待链上结算 + 同步CLOB余额 (卖出前必须)
      // Polygon结算需要时间, 等待充分后再同步
      await sleep(8000);
      for (let retry = 0; retry < 3; retry++) {
        try {
          await client.updateBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: tokenId });
          console.log(`[刷单] 余额同步成功 (尝试${retry + 1})`);
          break;
        } catch (e) {
          console.log(`[刷单] 余额同步失败 (尝试${retry + 1}): ${(e.message||"").slice(0,40)}`);
          await sleep(5000);
        }
      }

      return { side, tokenId, entryPrice, tokens, cost, negRisk: info.negRisk, entryTime: Date.now() };
    }
    console.log(`[刷单] 买入失败: ${resp.errorMsg || resp.error || "未知"}`);
  } catch (e) {
    console.log(`[刷单] 买入错误: ${e.message?.slice(0, 60)}`);
  }
  return null;
}

async function scalpExit(client, pos, stats, reason) {
  if (!pos || pos.tokens <= 0) return;

  // 查询 CLOB 实际余额, 取 99% 防止服务端余额缓存bug (GitHub Issue #287)
  let sellAmount = pos.tokens;
  try {
    await client.updateBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: pos.tokenId });
    await sleep(500);
    const bal = await client.getBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: pos.tokenId });
    const clobBalance = parseFloat(bal.balance || "0") / 1e6;
    if (clobBalance > 0) {
      sellAmount = Math.min(sellAmount, clobBalance);
    }
  } catch {}
  // 取 99% + floor 防止浮点精度问题
  sellAmount = Math.floor(sellAmount * 0.99 * 1e4) / 1e4;
  if (sellAmount <= 0) {
    console.log(`[平仓] ${reason} | 无可卖余额, 持有到结算`);
    return;
  }

  console.log(`[平仓] ${reason} | SELL ${pos.side} ${sellAmount.toFixed(4)} tokens (原${pos.tokens.toFixed(3)})`);

  // 重试卖出 (递增延迟, 最多4次)
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) {
      await sleep(2000 * attempt);
      // 重新同步余额
      try {
        await client.updateBalanceAllowance({ asset_type: AssetType.CONDITIONAL, token_id: pos.tokenId });
      } catch {}
      console.log(`[平仓] 重试 ${attempt + 1}/4...`);
    }

    try {
      const resp = await client.createAndPostMarketOrder(
        { tokenID: pos.tokenId, amount: sellAmount, side: Side.SELL, price: 0.01 },
        { negRisk: pos.negRisk },
        OrderType.FOK,
      );

      if (resp.success) {
        const received = parseFloat(resp.takingAmount || "0");
        const pnl = received > 0 ? received - pos.cost : 0;
        stats.pnl += pnl;
        if (pnl >= 0) stats.wins++; else stats.losses++;
        console.log(`[平仓] 成功 收回=$${received.toFixed(3)} PnL=$${pnl.toFixed(3)} | 累计W${stats.wins}/L${stats.losses} $${stats.pnl.toFixed(2)}`);
        return;
      }
      // 流动性不足 → 减少卖出量再试
      if ((resp.error || "").includes("fully filled")) {
        sellAmount = Math.floor(sellAmount * 0.5 * 1e4) / 1e4;
        console.log(`[平仓] 流动性不足, 减量到 ${sellAmount.toFixed(4)}`);
      }
    } catch (e) {
      console.log(`[平仓] 错误: ${(e.message||"").slice(0,50)}`);
    }
  }

  console.log(`[平仓] 卖出失败, 持有到结算`);
}

// ============ 主入口 ============

async function main() {
  const args = process.argv.slice(2);
  const command = (args[0] || "").toLowerCase();

  switch (command) {
    case "info":
      await cmdInfo();
      break;

    case "buy": {
      const side = args[1] || process.env.BET_SIDE || "";
      if (!side) {
        console.log("用法: node index.mjs buy <up|down> [金额]");
        break;
      }
      const amount = args[2] ? parseFloat(args[2]) : undefined;
      await cmdBuy(side, amount);
      break;
    }

    case "limit": {
      if (args.length < 4) {
        console.log("用法: node index.mjs limit <up|down> <价格> <数量>");
        break;
      }
      await cmdLimit(args[1], parseFloat(args[2]), parseFloat(args[3]));
      break;
    }

    case "book": {
      const side = args[1] || "up";
      await cmdBook(side);
      break;
    }

    case "orders":
      await cmdOrders();
      break;

    case "cancel":
      await cmdCancel();
      break;

    case "balance":
      await cmdBalance();
      break;

    case "auto": {
      const side = args[1] || process.env.BET_SIDE || "";
      if (!side) {
        console.log("用法: node index.mjs auto <up|down> [金额]");
        break;
      }
      const amount = args[2] ? parseFloat(args[2]) : undefined;
      await cmdAuto(side, amount);
      break;
    }

    case "strategy": {
      const amount = args[1] ? parseFloat(args[1]) : undefined;
      await cmdStrategy(amount);
      break;
    }

    case "strategy-auto": {
      const amount = args[1] ? parseFloat(args[1]) : undefined;
      await cmdStrategyAuto(amount);
      break;
    }

    case "scalp": {
      const amount = args[1] ? parseFloat(args[1]) : undefined;
      await cmdScalp(amount);
      break;
    }

    case "redeem":
    case "claim":
      await cmdRedeem();
      break;

    default:
      console.log(`
Polymarket BTC 5分钟市场下单工具

命令:
  info                          查看当前市场信息
  buy <up|down> [金额]          市价买入 (默认 $${DEFAULT_BET_AMOUNT})
  limit <up|down> <价格> <数量>  限价买入
  book <up|down>                查看订单簿
  orders                       查看未成交订单
  cancel                       取消所有订单
  balance                      查看 USDC 余额和持仓
  auto <up|down> [金额]         自动模式 (每个窗口自动下单)
  strategy [金额]               Binance趋势策略 (单次评估并下单)
  strategy-auto [金额]          Binance趋势策略 (连续自动)
  scalp [金额]                  刷单策略 (止盈止损, 一窗口多单)
  redeem / claim                领取获胜仓位奖励 (手动)

策略模式说明:
  strategy/strategy-auto 会先检查"过度自信反转":
    - 价格下跌 + DOWN市场价 > $${OVERCONFIDENCE_THRESHOLD} → 市场过度看跌 → 反转买UP
    - 价格上涨 + UP市场价 > $${OVERCONFIDENCE_THRESHOLD} → 市场过度看涨 → 反转买DOWN
  若未触发过度自信，则进入正常趋势/反转逻辑:
    - 低波动 + 最后1分钟下跌 → 反转模式 (买UP)
    - 正常波动 → 趋势模式 (跟随综合评分)

刷单策略说明 (scalp):
  不等窗口结算, 通过快速买卖赚取价差:
    - 监控BTC价格 15秒变动 > 0.03% → 入场
    - 止盈 3¢ / 止损 5¢ → 自动平仓
    - 每窗口最多5单, 冷却10秒
    - 结束前45秒强制平仓
  环境变量: SCALP_TP, SCALP_SL, SCALP_TRIGGER, SCALP_MAX_TRADES, SCALP_AMOUNT

示例:
  node index.mjs info
  node index.mjs buy up
  node index.mjs buy down 10
  node index.mjs limit up 0.55 20
  node index.mjs auto up 5
  node index.mjs strategy
  node index.mjs strategy-auto 10
  node index.mjs scalp 1
      `);
  }
}

main().catch(console.error);
