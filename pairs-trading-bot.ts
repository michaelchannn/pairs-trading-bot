import axios from 'axios';
import fs from 'fs';
import path from 'path';
import * as ss from 'simple-statistics';
import { PublicKey } from '@solana/web3.js';
import express from 'express';
import http from 'node:http';
import { Server } from 'socket.io';
import { CompositeClient, OrderSide, OrderType, SubaccountClient, Network, BECH32_PREFIX, LocalWallet } from '@dydxprotocol/v4-client-js';

console.log('Starting pairs trading bot...');

const app = express();
const server = http.createServer();
server.on('request', app);

const io = new Server(server);
app.use(express.static(path.join(__dirname, 'public')));

// start the server on port 3000
server.listen(3000, () => {
  console.log('Server is running on port 3000');
});

// Y and X are generic placeholders for the two tokens traded
const YTokenMint = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr'; //POPCAT
const XTokenMint = '2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump'; //PNUT

const YPubkey = new PublicKey(YTokenMint);
const XPubkey = new PublicKey(XTokenMint);

const YMarketID = 'POPCAT-USD'; 
const XMarketID = 'PNUT-USD';

const mintAddresses = [YTokenMint, XTokenMint]; 

// parameters
const entryThreshold = 3; 
const TakeProfitThreshold = 0.2; 
const StopLossThreshold = 4; 
const rollingWindowSize = 50; // number of data points to use for rolling statistics. Ensure stability, statistical significance, and robustness
const riskPerTrade = 0.02; // 2% of the total capital


const filePath = path.join(__dirname, 'five_minute_price_data_beta.csv');
let YPricePath: number[] = [];
let XPricePath: number[] = [];
let spreadPath: number[] = [];

interface PriceData {
  timestamp: string;
  tokenY: number | null;  
  tokenX: number | null; 
  spread: number | null;
  rollingBeta: number | null;
  rollingMean: number | null;
  rollingStd: number | null;
  zScore: number | null;
}

interface Position {
  isOpen: boolean;
  type: 'long' | 'short' | null;
  entryZScore: number | null;
  unitsY?: number;  
  unitsX?: number; 
}

let currentPosition: Position = {
  isOpen: false,
  type: null,
  entryZScore: null,
};

const getTokenPrice = async (mintAddress: string) => { // price of token in usdc
  try {
    const response = await axios.get(
      `https://api.jup.ag/price/v2?ids=${mintAddress}&vsToken=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
    );
    console.log('Price Data:', response.data);
    return response.data.data[mintAddress].price;
  } catch (error) {
    console.error(`Error fetching price for ${mintAddress}:`, error);
    return null;
  }
};

const shortTokenOnDYDX = async (marketID: string, shortAmountinUnits: number) => { // short function
  const mnemonic = '24 word secret phrase of dydx wallet'; 
  const localWallet = await LocalWallet.fromMnemonic(mnemonic, BECH32_PREFIX);

  const network = Network.mainnet();
  const client = await CompositeClient.connect(network);
  
  const subaccount = new SubaccountClient(localWallet, 0);

  const market = marketID;
  const type = OrderType.MARKET;
  const side = OrderSide.SELL; 
  
  const price = 0;
  const clientId = Date.now();

  const tx = await client.placeOrder(
    subaccount,
    market,
    type,
    side,
    price,
    shortAmountinUnits,
    clientId,
  );

  return tx;
};

const longTokenOnDYDX = async (marketID: string, buyAmountinUnits: number) => { // long function
  const mnemonic = '24 word secret phrase of dydx wallet'; 
  const localWallet = await LocalWallet.fromMnemonic(mnemonic, BECH32_PREFIX);

  const network = Network.mainnet();
  const client = await CompositeClient.connect(network);
  
  const subaccount = new SubaccountClient(localWallet, 0);

  const market = marketID;
  const type = OrderType.MARKET;
  const side = OrderSide.BUY;
  
  const price = 0;
  const clientId = Date.now();

  const tx = await client.placeOrder(
    subaccount,
    market,
    type,
    side,
    price,
    buyAmountinUnits,
    clientId,
  );

  return tx;
};

const fetchAllPrices = async () => { // main function
  try {
    const [YCurrentPrice, XCurrentPrice] = await Promise.all(mintAddresses.map(getTokenPrice));
    const currentTime = new Date().toISOString();

    if (YCurrentPrice === null || XCurrentPrice === null) {
      console.error('Price fetch failed for one of the tokens.');
      return;
    }

    YPricePath.push(YCurrentPrice);
    XPricePath.push(XCurrentPrice);

    let spread: number | null = null;
    let rollingMean: number | null = null;
    let rollingStd: number | null = null;
    let rollingBeta: number | null = null;
    let zScore: number | null = null;

    const dataPointCount = YPricePath.length;

    const walletBalance = 50; // flat 50 USDC balance. starting balance of wallet. should use websocket integration for dynamic updates

    if (dataPointCount < rollingWindowSize) {
      // not enough data for beta
      const priceData: PriceData = {
        timestamp: currentTime,
        tokenY: YCurrentPrice,   
        tokenX: XCurrentPrice,  
        spread: null,
        rollingMean: null,
        rollingStd: null,
        rollingBeta: null,
        zScore: null,
      };
      logPricesToCSV(priceData);

    } else {
      // enough data points for regression
      const recentYPrices = YPricePath.slice(-rollingWindowSize);
      const recentXPrices = XPricePath.slice(-rollingWindowSize);

      // regress Y on X: log(Y) = alpha + beta * log(X)
      const regressionData = recentXPrices.map((x, i) => [Math.log(x), Math.log(recentYPrices[i])]);

      rollingBeta = ss.linearRegression(regressionData).m;
      const originalBeta = rollingBeta;

      // initially define roles: Y, X remain Y and X after computing beta.
      let YLabel = 'Y';
      let XLabel = 'X';
      let YPrice = YCurrentPrice;
      let XPrice = XCurrentPrice;
      let hedgeInverted = false;

      // if beta < 0, force beta positive by swapping roles.
      // after flipping, what was X is now Y, and what was Y is now X
      if (rollingBeta < 0) {
        rollingBeta = -rollingBeta;
        hedgeInverted = true;
        [YPrice, XPrice] = [XPrice, YPrice];
        [YLabel, XLabel] = [XLabel, YLabel];
      }

      // spread calculation = Y - beta * X 
      spread = YPrice - rollingBeta * XPrice;

      // update spread array
      spreadPath.push(spread);
      if (spreadPath.length > rollingWindowSize) {
        spreadPath.shift();
      }

      if (dataPointCount < (rollingWindowSize * 2)) {
        // not enough data for stable z-score
        const priceData: PriceData = {
          timestamp: currentTime,
          tokenY: YPrice,
          tokenX: XPrice,
          spread: spread,
          rollingMean: null,
          rollingStd: null,
          rollingBeta: originalBeta,
          zScore: null,
        };
        logPricesToCSV(priceData);
      } else {
        // compute z-score
        const recentSpreads = spreadPath.slice(-rollingWindowSize);
        rollingMean = ss.mean(recentSpreads);
        rollingStd = ss.standardDeviation(recentSpreads);
        zScore = rollingStd !== 0 ? (spread - rollingMean) / rollingStd : null;

        io.emit('data', { timestamp: currentTime, spread: spread, rollingMean: rollingMean, zScore: zScore });

        if (zScore !== null) {
          const tradeCapitalUSD = walletBalance * riskPerTrade;
          const unitsY = (tradeCapitalUSD / (YPrice + rollingBeta * XPrice)) / 10;
          const unitsX = unitsY * rollingBeta;

          if (!currentPosition.isOpen) {
            // no open position
            if (zScore > entryThreshold) {
              // short spread: short Y, long X
              console.log(`[${currentTime}] Entering SHORT spread. Z-Score: ${zScore.toFixed(2)}, originalBeta: ${originalBeta.toFixed(4)}, usedBeta: ${rollingBeta.toFixed(4)}, hedgeInverted: ${hedgeInverted}`);

              currentPosition = {
                isOpen: true,
                type: 'short',
                entryZScore: zScore,
                unitsY: unitsY, 
                unitsX: unitsX   
              };

              // short Y on dYdX
              await shortTokenOnDYDX(YLabel === 'Y' ? YMarketID : XMarketID, unitsY);
              // long X on dYdX
              await longTokenOnDYDX(YLabel === 'Y' ? XMarketID : YMarketID, unitsX);

              io.emit('trade', {
                timestamp: currentTime,
                type: 'entry',
                positionType: 'short',
                zScore: zScore,
                spread: spread,
                originalBeta: originalBeta,
                usedBeta: rollingBeta,
                hedgeInverted: hedgeInverted
              });

            } else if (zScore < -entryThreshold) {
              // long spread: long Y, short X
              console.log(`[${currentTime}] Entering LONG spread. Z-Score: ${zScore.toFixed(2)}, originalBeta: ${originalBeta.toFixed(4)}, usedBeta: ${rollingBeta.toFixed(4)}, hedgeInverted: ${hedgeInverted}`);

              currentPosition = {
                isOpen: true,
                type: 'long',
                entryZScore: zScore,
                unitsY: unitsY,
                unitsX: unitsX
              };

              // long Y on dYdX
              await longTokenOnDYDX(YLabel === 'Y' ? YMarketID : XMarketID, unitsY); 

              // short X on dYdX
              await shortTokenOnDYDX(YLabel === 'Y' ? XMarketID : YMarketID, unitsX);

              io.emit('trade', {
                timestamp: currentTime,
                type: 'entry',
                positionType: 'long',
                zScore: zScore,
                spread: spread,
                originalBeta: originalBeta,
                usedBeta: rollingBeta,
                hedgeInverted: hedgeInverted
              });
            }

            const priceData: PriceData = {
              timestamp: currentTime,
              tokenY: YPrice,
              tokenX: XPrice,
              spread: spread,
              rollingMean: rollingMean,
              rollingStd: rollingStd,
              rollingBeta: originalBeta,
              zScore: zScore,
            };
            logPricesToCSV(priceData);

          } else {
            // position already open, check exit conditions
            if (currentPosition.type === 'short' && (zScore <= TakeProfitThreshold || zScore >= StopLossThreshold)) {
              console.log(`[${currentTime}] Closing SHORT spread. Z-Score: ${zScore.toFixed(2)}`);

              // Sell X on dYdX
              await shortTokenOnDYDX(YLabel === 'Y' ? XMarketID : YMarketID, unitsX); 

              // Long Y on dYdX
              await longTokenOnDYDX(YLabel === 'Y' ? YMarketID : XMarketID, unitsY); 

              io.emit('trade', {
                timestamp: currentTime,
                type: 'exit',
                positionType: 'short',
                zScore: zScore,
                spread: spread,
                originalBeta: originalBeta,
                usedBeta: rollingBeta,
                hedgeInverted: hedgeInverted
              });

              currentPosition = {
                isOpen: false,
                type: null,
                entryZScore: null,
              };

            } else if (currentPosition.type === 'long' && (zScore >= -TakeProfitThreshold || zScore <= -StopLossThreshold)) {
              console.log(`[${currentTime}] Closing LONG spread. Z-Score: ${zScore.toFixed(2)}`);
      
              // Sell Y on dYdX
              await shortTokenOnDYDX(YLabel === 'Y' ? YMarketID : XMarketID, unitsY); 
              // Long X on dYdX 
              await longTokenOnDYDX(YLabel === 'Y' ? XMarketID : YMarketID, unitsX);

              io.emit('trade', {
                timestamp: currentTime,
                type: 'exit',
                positionType: 'long',
                zScore: zScore,
                spread: spread,
                originalBeta: originalBeta,
                usedBeta: rollingBeta,
                hedgeInverted: hedgeInverted
              });

              currentPosition = {
                isOpen: false,
                type: null,
                entryZScore: null,
              };
            }

            const priceData: PriceData = {
              timestamp: currentTime,
              tokenY: YPrice,
              tokenX: XPrice,
              spread: spread,
              rollingMean: rollingMean,
              rollingStd: rollingStd,
              rollingBeta: originalBeta,
              zScore: zScore
            };
            logPricesToCSV(priceData);
          }
        }
      }
    }
  } catch (error) {
    console.error('Error fetching prices:', error);
  }
};

const logPricesToCSV = (priceData: PriceData) => {
  const header = 'Timestamp,token Y,token X,Rolling Beta,Spread,Rolling Mean,Rolling SD,Z-Score\n';
  const data = `${priceData.timestamp},${priceData.tokenY},${priceData.tokenX},${priceData.rollingBeta},${priceData.spread},${priceData.rollingMean},${priceData.rollingStd},${priceData.zScore}\n`;

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, header);
  }

  fs.appendFileSync(filePath, data);
};

setInterval(fetchAllPrices, 300000); // fetch prices every 5 minutes.
fetchAllPrices();
