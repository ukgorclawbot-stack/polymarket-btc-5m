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
import { ClobClient, OrderType, Side, AssetType } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";

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

// ============ 自动 Claim 获胜仓位 ============

async function cmdClaim() {
  const provider = new providers.JsonRpcProvider('https://1rpc.io/matic');
  const signer = new Wallet(PRIVATE_KEY, provider);
  
  const ctfAddress = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
  const ctfAbi = [
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] outcomeIndexes) public',
  ];
  const ctf = new Contract(ctfAddress, ctfAbi, signer);
  
  const usdce = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
  const parentCollectionId = '0x0000000000000000000000000000000000000000000000000000000000000000';
  
  const now = Math.floor(Date.now() / 1000);
  let claimed = 0;
  
  for (let i = 2; i <= 6; i++) {
    const windowTs = now - (now % MARKET_INTERVAL) - (i * MARKET_INTERVAL);
    const slug = getMarketSlug(windowTs);
    const event = await fetchMarket(slug);
    if (!event) continue;
    
    const market = (event.markets || [])[0];
    if (!market || !market.conditionId) continue;
    
    try {
      const tx = await ctf.redeemPositions(usdce, parentCollectionId, market.conditionId, [0, 1]);
      console.log(`[Claim] ${slug} — tx: ${tx.hash.slice(0, 20)}...`);
      await tx.wait();
      claimed++;
    } catch (e) {
      if (e.message?.includes('already') || e.message?.includes('nothing')) {
        console.log(`[Claim] ${slug} — 已领取或无仓位`);
      } else {
        console.log(`[Claim] ${slug} — 跳过: ${(e.reason || e.message || '').slice(0, 80)}`);
      }
    }
  }
  
  if (claimed > 0) {
    console.log(`\n✅ 成功领取 ${claimed} 个市场的奖励`);
  } else {
    console.log("\n[Claim] 本次没有需要领取的奖励");
  }
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
        try { await cmdClaim(); } catch(e) { console.log(`[Claim] 跳过: ${e.message?.slice(0, 50)}`); }
        
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

    case "claim":
      await cmdClaim();
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
  claim                        领取获胜仓位奖励 (手动)

策略模式说明:
  strategy/strategy-auto 会先检查"过度自信反转":
    - 价格下跌 + DOWN市场价 > $${OVERCONFIDENCE_THRESHOLD} → 市场过度看跌 → 反转买UP
    - 价格上涨 + UP市场价 > $${OVERCONFIDENCE_THRESHOLD} → 市场过度看涨 → 反转买DOWN
  若未触发过度自信，则进入正常趋势/反转逻辑:
    - 低波动 + 最后1分钟下跌 → 反转模式 (买UP)
    - 正常波动 → 趋势模式 (跟随综合评分)

示例:
  node index.mjs info
  node index.mjs buy up
  node index.mjs buy down 10
  node index.mjs limit up 0.55 20
  node index.mjs auto up 5
  node index.mjs strategy
  node index.mjs strategy-auto 10
      `);
  }
}

main().catch(console.error);
