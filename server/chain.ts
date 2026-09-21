import { ChainId, CHAIN_TO_ADDRESSES_MAP } from "@uniswap/sdk-core";
import { UniversalRouterVersion, UNIVERSAL_ROUTER_ADDRESS } from "@uniswap/universal-router-sdk";

export const ROBIN_CHAIN_ID = ChainId.ROBINHOOD;

const addrs = CHAIN_TO_ADDRESSES_MAP[ROBIN_CHAIN_ID];

export const ROBIN_CONTRACTS = {
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as const,
  poolManager: addrs.v4PoolManagerAddress as `0x${string}`,
  positionManager: addrs.v4PositionManagerAddress as `0x${string}`,
  stateView: addrs.v4StateView as `0x${string}`,
  v4Quoter: addrs.v4QuoterAddress as `0x${string}`,
  universalRouter: UNIVERSAL_ROUTER_ADDRESS(
    UniversalRouterVersion.V2_1_2,
    ROBIN_CHAIN_ID,
  ) as `0x${string}`,
  /** pools.trade / LiquidityLauncher 入口 */
  launchEntry: [
    "0x0000ffffbe8efe702c8703ae3477ff5de3d319c0",
    "0x00004c4ccc709ef590f7c81102c0689f0263d4e9",
  ] as const,
  /** Doppler Airlock — create(tuple) 发币 */
  dopplerAirlock: "0xeb7C034704eF8Dcd2D32324c1545f62fB4aD0862" as const,
  explorerTx: (hash: string) => `https://robinhoodchain.blockscout.com/tx/${hash}`,
};

export const TOKEN_CREATED_TOPIC =
  "0x2e2b3f61b70d2d131b2a807371103cc98d51adcaa5e9a8f9c32658ad8426e74e" as const;

/** Airlock Create(...) — data 首段为新建 asset 地址 */
export const AIRLOCK_CREATE_TOPIC =
  "0x68ff1cfcdcf76864161555fc0de1878d8f83ec6949bf351df74d8a4a1a2679ab" as const;

export const AIRLOCK_CREATE_SELECTOR = "0x882db707" as const;

export const POOL_INITIALIZE_TOPIC =
  "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438" as const;

export const robinChain = {
  id: ROBIN_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: {
      http: ["https://robinhood.api.pocket.network"],
      webSocket: ["wss://robinhood.api.pocket.network"],
    },
  },
};
